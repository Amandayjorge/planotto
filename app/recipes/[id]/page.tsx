"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import LinkifiedText from "../../components/LinkifiedText";
import ProductAutocompleteInput from "../../components/ProductAutocompleteInput";
import { appendProductSuggestions, loadProductSuggestions } from "../../lib/productSuggestions";
import {
  copyPublicRecipeToMine,
  deleteRecipe,
  getCurrentUserId,
  getRecipeById,
  isRecipeHiddenByReport,
  loadLocalRecipes,
  reportRecipeForReview,
  removeRecipeFromLocalCache,
  type Ingredient,
  type RecipeModel,
  type RecipeVisibility,
  updateRecipe,
  upsertRecipeInLocalCache,
} from "../../lib/recipesSupabase";
import { isSupabaseConfigured } from "../../lib/supabaseClient";
import { RECIPE_TAGS } from "../../lib/recipeTags";
import {
  getIngredientHints,
  getRecipeImage,
  getServingsHint,
  getTagHints,
} from "../../lib/aiAssistantClient";

const UNITS = ["г", "кг", "мл", "л", "шт", "ч.л.", "ст.л.", "по вкусу"];
type IngredientHintsMap = Record<number, string[]>;
const RECIPES_FIRST_FLOW_KEY = "recipesFirstFlowActive";
const FIRST_RECIPE_ADDED_KEY = "recipes:first-added-recipe-id";
const FIRST_RECIPE_SUCCESS_PENDING_KEY = "recipes:first-success-pending";
const FIRST_RECIPE_SUCCESS_SHOWN_KEY = "recipes:first-success-shown";

const looksLikeLink = (value: string): boolean => /^(https?:\/\/|www\.)/i.test(value.trim());

const normalizeLink = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const toErrorText = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const text = String((error as { message?: unknown }).message || "");
    if (text) return text;
  }
  return fallback;
};

const isMissingRecipesTableError = (error: unknown): boolean => {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const collect = (value: unknown): void => {
    if (value == null || seen.has(value)) return;
    if (typeof value === "object" || typeof value === "function") {
      seen.add(value);
    }

    if (typeof value === "string") {
      parts.push(value);
      return;
    }

    if (value instanceof Error) {
      parts.push(value.message || "");
      collect((value as Error & { cause?: unknown }).cause);
      return;
    }

    if (typeof value !== "object") {
      parts.push(String(value));
      return;
    }

    const typed = value as Record<string, unknown>;
    const fields = ["code", "message", "details", "hint", "error", "statusText", "name"] as const;
    fields.forEach((key) => {
      if (key in typed) collect(typed[key]);
    });
    if ("cause" in typed) collect(typed.cause);
  };

  collect(error);
  const text = parts.join(" ").toLowerCase();
  if (!text) return false;
  if (text.includes("42p01")) return true;
  if (text.includes("public.recipes") && text.includes("schema cache")) return true;
  if (text.includes("relation") && text.includes("recipes") && text.includes("does not exist")) return true;
  if (text.includes("could not find the table") && text.includes("recipes") && text.includes("schema cache")) return true;
  return false;
};

const TEMPLATE_IMAGE_FALLBACKS: Record<string, string> = {
  "Омлет с овощами": "/recipes/templates/omelet-vegetables.jpg",
  "Овсяная каша с фруктами": "/recipes/templates/oatmeal-fruits.jpg",
  "Курица с рисом": "/recipes/templates/chicken-rice.jpg",
  "Суп из чечевицы": "/recipes/templates/lentil-soup-v2.jpg",
  "Запеченная рыба с картофелем": "/recipes/templates/baked-fish-potatoes.jpg",
  "Паста с томатным соусом": "/recipes/templates/pasta-tomato.jpg",
  "Салат с тунцом": "/recipes/templates/tuna-salad.jpg",
  "Оладьи на кефире": "/recipes/templates/oladi-kefir.jpg",
};

const normalizeRecipeTitle = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

const resolveRecipeImage = (recipe: RecipeModel): string => {
  const normalizedTitle = normalizeRecipeTitle(recipe.title || "");
  const matched = Object.entries(TEMPLATE_IMAGE_FALLBACKS).find(
    ([title]) => normalizeRecipeTitle(title) === normalizedTitle
  );

  // Keep starter templates stable even if cached URL/image is broken.
  if (matched && recipe.type === "template") return matched[1];
  if (matched && normalizedTitle === normalizeRecipeTitle("Суп из чечевицы")) return matched[1];

  const direct = recipe.image?.trim();
  if (direct) return direct;
  return matched?.[1] || "";
};

export default function RecipeDetailPage() {
  const router = useRouter();
  const params = useParams();
  const recipeId = String(params.id || "");

  const [recipe, setRecipe] = useState<RecipeModel | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [shortDescription, setShortDescription] = useState("");
  const [recipeLink, setRecipeLink] = useState("");
  const [instructions, setInstructions] = useState("");
  const [notes, setNotes] = useState("");
  const [servings, setServings] = useState(2);
  const [visibility, setVisibility] = useState<RecipeVisibility>("private");
  const [publishConsentChecked, setPublishConsentChecked] = useState(false);
  const [image, setImage] = useState("");
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [productSuggestions, setProductSuggestions] = useState<string[]>([]);
  const [aiAction, setAiAction] = useState<"ingredients" | "tags" | "servings" | "image" | null>(null);
  const [aiMessage, setAiMessage] = useState("");
  const [ingredientHints, setIngredientHints] = useState<IngredientHintsMap>({});
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [suggestedServings, setSuggestedServings] = useState<number | null>(null);
  const [showAiTools, setShowAiTools] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportReason, setReportReason] = useState("Нарушение авторских прав");
  const [reportDetails, setReportDetails] = useState("");
  const [isReportedHidden, setIsReportedHidden] = useState(false);
  const hasCoreInput = title.trim().length > 0 || ingredients.some((item) => item.name.trim().length > 0);

  const canEdit = useMemo(() => {
    if (!recipe) return false;
    if (!recipe.ownerId) return true;
    return Boolean(currentUserId && recipe.ownerId === currentUserId);
  }, [currentUserId, recipe]);

  const handleVisibilityChange = (next: RecipeVisibility) => {
    if (next === "public" && visibility !== "public") {
      const approved = window.confirm(
        "Публичные рецепты видны другим пользователям.\nУбедитесь, что вы имеете право публиковать этот рецепт."
      );
      if (!approved) return;
    }
    setVisibility(next);
    if (next !== "public") {
      setPublishConsentChecked(false);
    }
  };

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    getCurrentUserId().then(setCurrentUserId).catch(() => setCurrentUserId(null));
  }, []);

  const resetFormFromRecipe = (source: RecipeModel) => {
    const descriptionText = source.description || "";
    const linkFromDescription = looksLikeLink(descriptionText) ? descriptionText : "";

    setTitle(source.title || "");
    setShortDescription(source.shortDescription || "");
    setRecipeLink(linkFromDescription);
    setInstructions(source.instructions || (linkFromDescription ? "" : descriptionText));
    setNotes(source.notes || "");
    setServings(source.servings && source.servings > 0 ? source.servings : 2);
    setVisibility(source.visibility || "private");
    setImage(source.image || "");
    setIngredients(source.ingredients || []);
    setSelectedTags(source.tags || source.categories || []);
  };

  const loadRecipe = async () => {
    setIsLoading(true);
    setProductSuggestions(loadProductSuggestions());

    try {
      const localRecipe = loadLocalRecipes().find((item) => item.id === recipeId) || null;

      if (!isSupabaseConfigured()) {
        setRecipe(localRecipe);
        if (localRecipe) resetFormFromRecipe(localRecipe);
        return;
      }

      if (localRecipe) {
        setRecipe(localRecipe);
        resetFormFromRecipe(localRecipe);
        setIsReportedHidden(false);
        if (!localRecipe.ownerId) {
          return;
        }
      }

      const data = await getRecipeById(recipeId, currentUserId);
      if (data && data.visibility === "public" && (!currentUserId || data.ownerId !== currentUserId)) {
        if (isRecipeHiddenByReport(data.id)) {
          setIsReportedHidden(true);
        } else {
          setIsReportedHidden(false);
        }
      } else {
        setIsReportedHidden(false);
      }
      setRecipe(data);
      if (data) resetFormFromRecipe(data);
    } catch (error) {
      const localRecipe = loadLocalRecipes().find((item) => item.id === recipeId) || null;
      if (isMissingRecipesTableError(error) && localRecipe) {
        const localFallback: RecipeModel = {
          ...localRecipe,
          ownerId: "",
          visibility: "private",
        };
        setRecipe(localFallback);
        resetFormFromRecipe(localFallback);
        setIsReportedHidden(false);
        return;
      }
      console.error("Failed to load recipe:", error);
      setRecipe(localRecipe);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadRecipe();
  }, [recipeId, currentUserId]);

  const addIngredient = () => {
    setIngredients((prev) => [...prev, { name: "", amount: 0, unit: UNITS[0] }]);
  };

  const removeIngredient = (index: number) => {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  };

  const updateIngredient = (index: number, field: keyof Ingredient, value: string | number) => {
    setIngredients((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const handleImageUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setImage(String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const requestIngredientHints = async () => {
    const prepared = ingredients
      .map((item, index) => ({ index, name: item.name.trim() }))
      .filter((item) => item.name.length > 0);

    if (prepared.length === 0) {
      setAiMessage("Сначала добавьте хотя бы один ингредиент.");
      return;
    }

    try {
      setAiAction("ingredients");
      const data = await getIngredientHints({
        ingredients: prepared,
        knownProducts: productSuggestions,
      });

      const map: IngredientHintsMap = {};
      for (const item of data.items || []) {
        if (!Number.isInteger(item.index)) continue;
        const options = Array.isArray(item.suggestions)
          ? item.suggestions.filter((name) => typeof name === "string" && name.trim().length > 0)
          : [];
        if (options.length > 0) map[item.index] = options.slice(0, 4);
      }

      setIngredientHints(map);
      setAiMessage(Object.keys(map).length > 0 ? "ИИ предложил варианты названий." : "Подсказки не найдены.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось получить подсказки ингредиентов.";
      setAiMessage(text);
    } finally {
      setAiAction(null);
    }
  };

  const requestTagHints = async () => {
    try {
      setAiAction("tags");
      const data = await getTagHints({
        title: title.trim(),
        shortDescription: shortDescription.trim(),
        instructions: instructions.trim(),
        ingredients: ingredients.map((item) => item.name.trim()).filter(Boolean),
      });

      const allowed = new Set(RECIPE_TAGS as readonly string[]);
      const next = (data.suggestedTags || []).filter((tag) => allowed.has(tag));
      setSuggestedTags(next);
      setAiMessage(data.message || (next.length > 0 ? "ИИ предложил теги." : "ИИ не нашел явных тегов."));
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось получить подсказки тегов.";
      setAiMessage(text);
    } finally {
      setAiAction(null);
    }
  };

  const requestServingsHint = async () => {
    try {
      setAiAction("servings");
      const data = await getServingsHint({
        title: title.trim(),
        ingredients: ingredients
          .filter((item) => item.name.trim().length > 0)
          .map((item) => ({ name: item.name.trim(), amount: Number(item.amount || 0), unit: item.unit || UNITS[0] })),
      });
      setSuggestedServings(data.suggestedServings && data.suggestedServings > 0 ? data.suggestedServings : null);
      setAiMessage(data.message || "Подсказка по порциям готова.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось получить подсказку по порциям.";
      setAiMessage(text);
    } finally {
      setAiAction(null);
    }
  };

  const requestRecipeImage = async () => {
    try {
      setAiAction("image");
      const data = await getRecipeImage({
        title: title.trim(),
        shortDescription: shortDescription.trim(),
        instructions: instructions.trim(),
        ingredients: ingredients.map((item) => item.name.trim()).filter(Boolean),
      });

      if (data.imageUrl) {
        setImage(data.imageUrl);
        setAiMessage(data.message || "Фото сгенерировано.");
      } else {
        setAiMessage("ИИ не вернул изображение.");
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось сгенерировать фото.";
      setAiMessage(text);
    } finally {
      setAiAction(null);
    }
  };

  const saveCurrentRecipe = async () => {
    if (!title.trim()) {
      alert("Название рецепта обязательно");
      return;
    }

    if (!recipe) return;
    if (recipe.visibility !== "public" && visibility === "public" && !publishConsentChecked) {
      alert("Подтвердите право на публикацию рецепта.");
      return;
    }

    const normalizedIngredients = ingredients
      .filter((item) => item.name.trim())
      .map((item) => ({
        name: item.name.trim(),
        amount: item.unit === "по вкусу" ? 0 : Math.max(0, item.amount || 0),
        unit: item.unit || UNITS[0],
      }));
    const normalizedTags = Array.from(new Set(selectedTags.map((tag) => tag.trim()).filter(Boolean)));
    const normalizedRecipeLink = normalizeLink(recipeLink);

    const names = normalizedIngredients.map((item) => item.name);
    if (names.length > 0) {
      appendProductSuggestions(names);
      setProductSuggestions(loadProductSuggestions());
    }

    try {
      setIsSaving(true);

      const isLocalRecipe = !recipe.ownerId;

      if (!isSupabaseConfigured() || isLocalRecipe) {
        const updated: RecipeModel = {
          ...recipe,
          title: title.trim(),
          shortDescription: shortDescription.trim(),
          description: normalizedRecipeLink,
          instructions: instructions.trim(),
          notes: notes.trim(),
          ingredients: normalizedIngredients,
          servings: servings > 0 ? servings : 2,
          image: image.trim(),
          visibility: "private",
          categories: normalizedTags,
          tags: normalizedTags,
        };
        upsertRecipeInLocalCache(updated);
        setRecipe(updated);
        setIsEditing(false);
        return;
      }

      if (!currentUserId || !canEdit) {
        alert("Редактировать может только владелец рецепта.");
        return;
      }

      const updated = await updateRecipe(currentUserId, recipe.id, {
        title: title.trim(),
        shortDescription: shortDescription.trim(),
        description: normalizedRecipeLink,
        instructions: instructions.trim(),
        notes: notes.trim(),
        ingredients: normalizedIngredients,
        servings: servings > 0 ? servings : 2,
        image: image.trim(),
        visibility,
        categories: normalizedTags,
        tags: normalizedTags,
      });

      upsertRecipeInLocalCache(updated);
      setRecipe(updated);
      setIsEditing(false);
    } catch (error) {
      if (isMissingRecipesTableError(error)) {
        const updatedLocal: RecipeModel = {
          ...recipe,
          ownerId: "",
          title: title.trim(),
          shortDescription: shortDescription.trim(),
          description: normalizedRecipeLink,
          instructions: instructions.trim(),
          notes: notes.trim(),
          ingredients: normalizedIngredients,
          servings: servings > 0 ? servings : 2,
          image: image.trim(),
          visibility: "private",
          categories: normalizedTags,
          tags: normalizedTags,
        };
        upsertRecipeInLocalCache(updatedLocal);
        setRecipe(updatedLocal);
        setIsEditing(false);
        return;
      }
      const text = error instanceof Error ? error.message : "Не удалось сохранить рецепт.";
      alert(text);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteCurrentRecipe = async () => {
    if (!recipe) return;
    if (!confirm("Удалить этот рецепт?")) return;

    try {
      if (!isSupabaseConfigured() || !recipe.ownerId) {
        removeRecipeFromLocalCache(recipe.id);
        router.push("/recipes");
        return;
      }

      if (!currentUserId || !canEdit) {
        alert("Удалять может только владелец рецепта.");
        return;
      }

      await deleteRecipe(currentUserId, recipe.id);
      removeRecipeFromLocalCache(recipe.id);
      router.push("/recipes");
    } catch (error) {
      if (isMissingRecipesTableError(error)) {
        removeRecipeFromLocalCache(recipe.id);
        router.push("/recipes");
        return;
      }
      const text = error instanceof Error ? error.message : "Не удалось удалить рецепт.";
      alert(text);
    }
  };

  const copyToMine = async () => {
    if (!recipe) return;
    const shouldShowFirstRecipeOverlay =
      typeof window !== "undefined" &&
      (localStorage.getItem(RECIPES_FIRST_FLOW_KEY) === "1" ||
        localStorage.getItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY) !== "1");

    let targetUserId = currentUserId;
    if (!targetUserId && isSupabaseConfigured()) {
      try {
        targetUserId = await getCurrentUserId();
        if (targetUserId) setCurrentUserId(targetUserId);
      } catch {
        targetUserId = null;
      }
    }

    if (!targetUserId) {
      const existingLocal = loadLocalRecipes().find(
        (item) => normalizeRecipeTitle(item.title || "") === normalizeRecipeTitle(recipe.title || "")
      );
      if (existingLocal) {
        if (shouldShowFirstRecipeOverlay && typeof window !== "undefined") {
          localStorage.setItem(FIRST_RECIPE_ADDED_KEY, existingLocal.id);
          localStorage.setItem(FIRST_RECIPE_SUCCESS_PENDING_KEY, "1");
          router.push(`/recipes?firstAdded=1&recipe=${encodeURIComponent(existingLocal.id)}`);
        } else {
          router.push(`/recipes/${existingLocal.id}`);
        }
        return;
      }

      const localCopy: RecipeModel = {
        ...recipe,
        id: crypto.randomUUID(),
        ownerId: "",
        type: "user",
        isTemplate: false,
        visibility: "private",
        notes: recipe.notes || "",
      };
      upsertRecipeInLocalCache(localCopy);
      if (shouldShowFirstRecipeOverlay && typeof window !== "undefined") {
        localStorage.setItem(FIRST_RECIPE_ADDED_KEY, localCopy.id);
        localStorage.setItem(FIRST_RECIPE_SUCCESS_PENDING_KEY, "1");
        router.push(`/recipes?firstAdded=1&recipe=${encodeURIComponent(localCopy.id)}`);
      } else {
        router.push(`/recipes/${localCopy.id}`);
      }
      return;
    }

    try {
      const copied = await copyPublicRecipeToMine(targetUserId, recipe.id);
      upsertRecipeInLocalCache(copied);
      if (shouldShowFirstRecipeOverlay && typeof window !== "undefined") {
        localStorage.setItem(FIRST_RECIPE_ADDED_KEY, copied.id);
        localStorage.setItem(FIRST_RECIPE_SUCCESS_PENDING_KEY, "1");
        router.push(`/recipes?firstAdded=1&recipe=${encodeURIComponent(copied.id)}`);
      } else {
        router.push(`/recipes/${copied.id}`);
      }
    } catch (error) {
      if (isMissingRecipesTableError(error)) {
        const localCopy: RecipeModel = {
          ...recipe,
          id: crypto.randomUUID(),
          ownerId: "",
          type: "user",
          isTemplate: false,
          visibility: "private",
          notes: recipe.notes || "",
        };
        upsertRecipeInLocalCache(localCopy);
        if (shouldShowFirstRecipeOverlay && typeof window !== "undefined") {
          localStorage.setItem(FIRST_RECIPE_ADDED_KEY, localCopy.id);
          localStorage.setItem(FIRST_RECIPE_SUCCESS_PENDING_KEY, "1");
          router.push(`/recipes?firstAdded=1&recipe=${encodeURIComponent(localCopy.id)}`);
        } else {
          router.push(`/recipes/${localCopy.id}`);
        }
        return;
      }
      const text = toErrorText(error, "Не удалось скопировать рецепт.");
      alert(text);
    }
  };

  const submitReport = () => {
    if (!recipe) return;
    reportRecipeForReview(
      recipe.id,
      reportReason as
        | "Нарушение авторских прав"
        | "Чужой рецепт без указания источника"
        | "Другое",
      reportDetails
    );
    setShowReportForm(false);
    setIsReportedHidden(true);
  };

  if (isLoading) {
    return <div style={{ padding: "20px", textAlign: "center" }}>Загрузка...</div>;
  }

  if (isReportedHidden) {
    return (
      <div style={{ padding: "20px", maxWidth: "760px", margin: "0 auto" }}>
        <div className="card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>Рецепт временно скрыт</h2>
          <p style={{ marginBottom: "12px" }}>
            Рецепт будет временно скрыт до проверки.
            Если нарушение подтвердится, рецепт будет удален.
          </p>
          <button className="btn" onClick={() => router.push("/recipes")}>
            К списку рецептов
          </button>
        </div>
      </div>
    );
  }

  if (!recipe) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <p>Рецепт не найден</p>
        <button className="btn" onClick={() => router.push("/recipes")}>К списку рецептов</button>
      </div>
    );
  }

  const recipeLinkView = looksLikeLink(recipe.description || "") ? normalizeLink(recipe.description || "") : "";
  const cookingText = recipe.instructions || (recipeLinkView ? "" : recipe.description || "");
  const showCopyButton = recipe.visibility === "public" && (!currentUserId || recipe.ownerId !== currentUserId);
  const showReportButton = recipe.visibility === "public" && (!currentUserId || recipe.ownerId !== currentUserId);
  const canChangeVisibility = Boolean(recipe.ownerId && currentUserId && recipe.ownerId === currentUserId);
  const makingPublic = recipe.visibility !== "public" && visibility === "public";
  const recipeImage = resolveRecipeImage(recipe);

  return (
    <div style={{ padding: "20px", maxWidth: "900px", margin: "0 auto" }}>
      <div style={{ marginBottom: "20px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button className="btn" onClick={() => router.push("/recipes")}>← Назад к рецептам</button>

        {!isEditing && canEdit && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setIsEditing(true);
              setShowAiTools(false);
              setShowAdvancedFields(false);
            }}
          >
            Редактировать
          </button>
        )}

        {isEditing && (
          <>
            <button
              className="btn btn-primary"
              onClick={saveCurrentRecipe}
              disabled={isSaving || (makingPublic && !publishConsentChecked)}
            >
              {isSaving ? "Сохранение..." : makingPublic ? "Сделать публичным" : "Сохранить"}
            </button>
            <button
              className="btn"
              onClick={() => {
                resetFormFromRecipe(recipe);
                setIsEditing(false);
              }}
            >
              Отмена
            </button>
          </>
        )}

        {canEdit && (
          <button className="btn btn-danger" onClick={deleteCurrentRecipe}>
            Удалить
          </button>
        )}

        {showCopyButton && (
          <button className="btn btn-primary" onClick={copyToMine}>Добавить в мои рецепты</button>
        )}

        {showReportButton && !isEditing && (
          <button
            type="button"
            className="recipes-report-link"
            onClick={() => setShowReportForm((prev) => !prev)}
          >
            Пожаловаться
          </button>
        )}
      </div>

      {showReportButton && showReportForm && !isEditing && (
        <div className="card" style={{ marginBottom: "16px", padding: "14px" }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
            Причина
          </label>
          <select
            className="input"
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            style={{ maxWidth: "360px", marginBottom: "10px" }}
          >
            <option>Нарушение авторских прав</option>
            <option>Чужой рецепт без указания источника</option>
            <option>Другое</option>
          </select>
          <textarea
            className="input"
            rows={3}
            value={reportDetails}
            onChange={(e) => setReportDetails(e.target.value)}
            placeholder="Комментарий (необязательно)"
            style={{ minHeight: "80px" }}
          />
          <p className="muted" style={{ marginTop: "8px" }}>
            Рецепт будет временно скрыт до проверки.
            Если нарушение подтвердится, рецепт будет удален.
          </p>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <button className="btn btn-primary" onClick={submitReport}>
              Отправить жалобу
            </button>
            <button className="btn" onClick={() => setShowReportForm(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {isEditing ? (
        <div>
          {aiMessage && (
            <p className="muted" style={{ marginBottom: "14px" }}>
              Отто: {aiMessage}
            </p>
          )}

          <p className="muted" style={{ marginTop: "-4px", marginBottom: "14px" }}>
            Быстрый старт: достаточно названия и ингредиентов. Остальное можно поправить позже.
          </p>

          <div className="card" style={{ marginBottom: "14px", padding: "14px" }}>
            <h3 style={{ margin: "0 0 10px 0" }}>Шаг 1. Основное</h3>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold", fontSize: "18px" }}>Название</label>
              <input className="input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px", flexWrap: "wrap" }}>
                <label style={{ display: "block", fontWeight: "bold" }}>Ингредиенты</label>
              </div>
            {ingredients.map((ingredient, index) => (
              <div key={index} style={{ marginBottom: "10px" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <ProductAutocompleteInput
                      value={ingredient.name}
                      onChange={(nextValue) => updateIngredient(index, "name", nextValue)}
                      suggestions={productSuggestions}
                      placeholder="Название"
                    />
                  </div>
                  <input
                    className="input"
                    type="number"
                    value={ingredient.amount > 0 ? ingredient.amount : ""}
                    onChange={(e) =>
                      updateIngredient(
                        index,
                        "amount",
                        e.target.value.trim() === "" ? 0 : parseFloat(e.target.value) || 0
                      )
                    }
                    step="0.1"
                    min="0"
                    placeholder="Кол-во"
                    style={{ width: "110px" }}
                  />
                  <select
                    className="input"
                    value={ingredient.unit}
                    onChange={(e) => updateIngredient(index, "unit", e.target.value)}
                    style={{ width: "120px" }}
                  >
                    {UNITS.map((unit) => (
                      <option key={unit} value={unit}>{unit}</option>
                    ))}
                  </select>
                  <button className="btn btn-danger" onClick={() => removeIngredient(index)}>Удалить</button>
                </div>
                {ingredientHints[index]?.length ? (
                  <div style={{ marginTop: "6px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {ingredientHints[index].map((hint) => (
                      <button
                        key={`${index}-${hint}`}
                        className="btn"
                        onClick={() => {
                          updateIngredient(index, "name", hint);
                          setIngredientHints((prev) => {
                            const next = { ...prev };
                            delete next[index];
                            return next;
                          });
                        }}
                      >
                        {hint}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
              <button className="btn btn-add" onClick={addIngredient}>+ Добавить ингредиент</button>
            </div>

            <div style={{ marginBottom: "0" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Способ приготовления</label>
              <textarea
                className="input"
                rows={8}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                style={{ minHeight: "150px", resize: "vertical" }}
              />
            </div>
          </div>

          <div className="card" style={{ marginBottom: "14px", padding: "12px", background: "var(--background-secondary)" }}>
            <button className="btn" type="button" onClick={() => setShowAiTools((prev) => !prev)}>
              {showAiTools ? "Скрыть подсказки Отто" : "Отто поможет (необязательно)"}
            </button>
            {showAiTools ? (
              <div style={{ marginTop: "10px" }}>
                <p className="muted" style={{ marginTop: 0, marginBottom: "8px" }}>
                  Это дополнительные подсказки. Рецепт можно сохранить без них.
                </p>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button className="btn" onClick={requestIngredientHints} disabled={aiAction === "ingredients" || !hasCoreInput}>
                    {aiAction === "ingredients" ? "Ищу..." : "Подсказать названия"}
                  </button>
                  <button className="btn" onClick={requestServingsHint} disabled={aiAction === "servings" || !hasCoreInput}>
                    {aiAction === "servings" ? "Считаю..." : "Подсказать порции"}
                  </button>
                  <button className="btn" onClick={requestTagHints} disabled={aiAction === "tags" || !hasCoreInput}>
                    {aiAction === "tags" ? "Думаю..." : "Предложить теги"}
                  </button>
                  <button className="btn" onClick={requestRecipeImage} disabled={aiAction === "image" || !hasCoreInput}>
                    {aiAction === "image" ? "Генерация..." : "Сгенерировать фото"}
                  </button>
                  {suggestedServings ? (
                    <button className="btn btn-primary" onClick={() => setServings(suggestedServings)}>
                      Применить порции: {suggestedServings}
                    </button>
                  ) : null}
                  {suggestedTags.length > 0 ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => setSelectedTags((prev) => Array.from(new Set([...prev, ...suggestedTags])))}
                    >
                      Добавить предложенные теги
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="card" style={{ marginBottom: "20px", padding: "12px", background: "var(--background-secondary)" }}>
            <button className="btn" type="button" onClick={() => setShowAdvancedFields((prev) => !prev)}>
              {showAdvancedFields ? "Скрыть дополнительное" : "Шаг 2. Дополнительно (необязательно)"}
            </button>
            {showAdvancedFields ? (
              <div style={{ marginTop: "12px" }}>
                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Короткое описание</label>
                  <textarea
                    className="input"
                    rows={3}
                    value={shortDescription}
                    onChange={(e) => setShortDescription(e.target.value)}
                    style={{ minHeight: "70px", resize: "vertical" }}
                  />
                </div>

                <div style={{ marginBottom: "16px", display: "flex", gap: "16px", flexWrap: "wrap" }}>
                  <label style={{ display: "block", fontWeight: "bold" }}>
                    Порции
                    <input
                      className="input"
                      type="number"
                      min={1}
                      step={1}
                      value={servings}
                      onChange={(e) => setServings(parseInt(e.target.value, 10) || 0)}
                      style={{ width: "180px", marginTop: "8px" }}
                    />
                  </label>

                  <label style={{ display: "block", fontWeight: "bold" }}>
                    Видимость
                    <select
                      className="input"
                      value={visibility}
                      onChange={(e) => handleVisibilityChange(e.target.value as RecipeVisibility)}
                      disabled={!canChangeVisibility}
                      style={{ width: "180px", marginTop: "8px" }}
                    >
                      <option value="private">Приватный</option>
                      <option value="public">Публичный</option>
                    </select>
                    {!canChangeVisibility ? (
                      <span className="muted" style={{ display: "block", marginTop: "6px", fontWeight: 400 }}>
                        Публичный доступен только для рецептов аккаунта.
                      </span>
                    ) : null}
                  </label>
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
                    Источник (необязательно)
                  </label>
                  <input
                    className="input"
                    type="url"
                    value={recipeLink}
                    onChange={(e) => setRecipeLink(e.target.value)}
                    placeholder="https://..."
                  />
                  <p className="muted" style={{ marginTop: "8px" }}>
                    Если рецепт взят из книги или сайта, укажите источник.
                  </p>
                  {visibility === "public" ? (
                    <p className="muted" style={{ marginTop: "8px" }}>
                      Если источник не указан, ответственность за публикацию остается на вас.
                    </p>
                  ) : null}
                </div>

                {visibility === "public" && makingPublic ? (
                  <div className="card" style={{ marginBottom: "16px", padding: "14px" }}>
                    <h3 style={{ margin: "0 0 10px 0" }}>Публикация рецепта</h3>
                    <p style={{ margin: "0 0 10px 0", whiteSpace: "pre-line" }}>
                      Я подтверждаю, что имею право публиковать этот рецепт и что он не нарушает авторские права третьих лиц.
                      {"\n"}
                      Я понимаю, что в случае нарушения ответственность лежит на мне.
                    </p>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={publishConsentChecked}
                        onChange={(e) => setPublishConsentChecked(e.target.checked)}
                      />
                      <span>Согласен(на)</span>
                    </label>
                  </div>
                ) : null}

                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: "8px" }}>Теги (необязательно)</label>
                  {suggestedTags.length > 0 ? (
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                      {suggestedTags.map((tag) => (
                        <button
                          key={`hint-${tag}`}
                          className="btn"
                          onClick={() => setSelectedTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]))}
                        >
                          + {tag}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {RECIPE_TAGS.map((tag) => {
                      const checked = selectedTags.includes(tag);
                      return (
                        <label
                          key={tag}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            border: "1px solid var(--border-default)",
                            borderRadius: "999px",
                            padding: "6px 10px",
                            background: checked ? "var(--background-secondary)" : "var(--background-primary)",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedTags((prev) =>
                                e.target.checked ? [...prev, tag] : prev.filter((item) => item !== tag)
                              );
                            }}
                          />
                          <span style={{ fontSize: "13px" }}>{tag}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Картинка</label>
                  {image ? (
                    <div>
                      <img
                        src={image}
                        alt="Превью рецепта"
                        style={{ maxWidth: "220px", maxHeight: "220px", borderRadius: "10px", display: "block", marginBottom: "10px" }}
                      />
                      <button className="btn btn-danger" onClick={() => setImage("")}>Удалить картинку</button>
                    </div>
                  ) : (
                    <input type="file" accept="image/*" onChange={handleImageUpload} className="input" />
                  )}
                </div>

                <div style={{ marginBottom: "0" }}>
                  <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Личные заметки</label>
                  <textarea
                    className="input"
                    rows={4}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    style={{ minHeight: "90px", resize: "vertical" }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div>
          {recipeImage && (
            <div style={{ marginBottom: "20px", textAlign: "center" }}>
              <img
                src={recipeImage}
                alt={recipe.title}
                style={{ maxWidth: "100%", maxHeight: "400px", borderRadius: "12px", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
              />
            </div>
          )}

          <h1 className="h1" style={{ marginBottom: "10px" }}>{recipe.title}</h1>

          {recipe.shortDescription && (
            <p style={{ marginBottom: "16px", color: "var(--text-secondary)" }}>
              <LinkifiedText text={recipe.shortDescription} />
            </p>
          )}

          <p style={{ marginBottom: "10px" }}>
            <strong>Порции:</strong> {recipe.servings || 2}
          </p>

          <p style={{ marginBottom: "16px" }}>
            <strong>Видимость:</strong> {recipe.visibility === "public" ? "Публичный" : "Приватный"}
          </p>

          {recipe.tags && recipe.tags.length > 0 && (
            <div style={{ marginBottom: "16px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {recipe.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    border: "1px solid var(--border-default)",
                    borderRadius: "999px",
                    padding: "4px 10px",
                    fontSize: "12px",
                    background: "var(--background-secondary)",
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {recipeLinkView && (
            <p style={{ marginBottom: "16px" }}>
              <strong>Источник:</strong>{" "}
              <a href={recipeLinkView} target="_blank" rel="noopener noreferrer">
                Открыть источник
              </a>
            </p>
          )}

          {recipe.ingredients && recipe.ingredients.length > 0 && (
            <div style={{ marginBottom: "20px" }}>
              <h3 style={{ marginBottom: "10px" }}>Ингредиенты</h3>
              <ul style={{ paddingLeft: "20px" }}>
                {recipe.ingredients.map((item, index) => (
                  <li key={index}>
                    {item.unit === "по вкусу" ? `${item.name} — по вкусу` : `${item.amount} ${item.unit} ${item.name}`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {cookingText && (
            <div style={{ marginBottom: "20px" }}>
              <h3 style={{ marginBottom: "10px" }}>Способ приготовления</h3>
              <div className="card" style={{ padding: "12px", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                <LinkifiedText text={cookingText} />
              </div>
            </div>
          )}

          {canEdit && recipe.notes && (
            <div style={{ marginBottom: "20px" }}>
              <h3 style={{ marginBottom: "10px" }}>Личные заметки</h3>
              <div className="card" style={{ padding: "12px" }}>{recipe.notes}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
