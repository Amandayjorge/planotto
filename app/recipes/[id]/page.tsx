"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import LinkifiedText from "../../components/LinkifiedText";
import ProductAutocompleteInput from "../../components/ProductAutocompleteInput";
import { appendProductSuggestions, loadProductSuggestions } from "../../lib/productSuggestions";
import {
  copyPublicRecipeToMine,
  deleteRecipe,
  getCurrentUserId,
  getRecipeById,
  isRecipeHiddenByReport,
  listRecipeAccessEmails,
  loadLocalRecipes,
  replaceRecipeAccessByEmail,
  sendRecipeAccessInvites,
  reportRecipeForReview,
  removeRecipeFromLocalCache,
  type Ingredient,
  type RecipeLanguage,
  type RecipeModel,
  type RecipeTranslation,
  type RecipeVisibility,
  upsertRecipeTranslation,
  updateRecipe,
  upsertRecipeInLocalCache,
} from "../../lib/recipesSupabase";
import { useI18n } from "../../components/I18nProvider";
import { getIngredientNameById } from "../../lib/ingredientDictionary";
import { isSupabaseConfigured } from "../../lib/supabaseClient";
import { RECIPE_TAGS } from "../../lib/recipeTags";
import {
  getIngredientHints,
  getRecipeTranslationDraft,
  getRecipeImage,
  getServingsHint,
  getTagHints,
} from "../../lib/aiAssistantClient";

const UNITS = ["г", "кг", "мл", "л", "шт", "ч.л.", "ст.л.", "по вкусу"];
type IngredientHintsMap = Record<number, string[]>;
const RECIPE_LANGUAGES: RecipeLanguage[] = ["ru", "en", "es"];
const LANGUAGE_LABELS: Record<RecipeLanguage, string> = { ru: "RU", en: "EN", es: "ES" };
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

const isMissingRecipeTranslationsTableError = (error: unknown): boolean => {
  const text = toErrorText(error, "").toLowerCase();
  if (!text) return false;
  if (text.includes("42p01") && text.includes("recipe_translations")) return true;
  if (text.includes("recipe_translations") && text.includes("does not exist")) return true;
  if (text.includes("could not find the table") && text.includes("recipe_translations")) return true;
  if (text.includes("schema cache") && text.includes("recipe_translations")) return true;
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
const normalizeRecipeLanguage = (value: unknown): RecipeLanguage =>
  value === "ru" || value === "en" || value === "es" ? value : "ru";

const ACCESS_OPTIONS: Array<{
  value: RecipeVisibility;
  label: string;
  description: string;
}> = [
  { value: "private", label: "Личный", description: "Только владелец." },
  { value: "public", label: "Публичный", description: "Виден всем в библиотеке." },
  { value: "link", label: "По ссылке", description: "Доступ по прямой ссылке." },
  { value: "invited", label: "По приглашению", description: "Только приглашенным пользователям." },
];

const VISIBILITY_LABELS: Record<RecipeVisibility, string> = {
  private: "Личный",
  public: "Публичный",
  link: "По ссылке",
  invited: "По приглашению",
};

const generateShareToken = (): string => crypto.randomUUID().replace(/-/g, "");

const parseInvitedEmails = (raw: string): string[] => {
  const unique = new Set<string>();
  raw
    .split(/[\n,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => unique.add(item.toLowerCase()));

  return Array.from(unique);
};

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
  const { locale } = useI18n();
  const params = useParams();
  const searchParams = useSearchParams();
  const recipeId = String(params.id || "");
  const sharedTokenFromQuery = String(searchParams.get("share") || "").trim();

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
  const [shareToken, setShareToken] = useState("");
  const [invitedEmailsDraft, setInvitedEmailsDraft] = useState("");
  const [showInvitedAccessEditor, setShowInvitedAccessEditor] = useState(false);
  const [shareCopyMessage, setShareCopyMessage] = useState("");
  const [accessNotice, setAccessNotice] = useState("");
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
  const [contentLanguage, setContentLanguage] = useState<RecipeLanguage>("ru");
  const [translationNotice, setTranslationNotice] = useState("");
  const [isCreatingTranslation, setIsCreatingTranslation] = useState(false);
  const hasCoreInput = title.trim().length > 0 || ingredients.some((item) => item.name.trim().length > 0);

  const canEdit = useMemo(() => {
    if (!recipe) return false;
    if (!recipe.ownerId) return true;
    return Boolean(currentUserId && recipe.ownerId === currentUserId);
  }, [currentUserId, recipe]);

  const handleVisibilityChange = (next: RecipeVisibility) => {
    if (next !== "private" && (!recipe?.ownerId || !currentUserId || recipe.ownerId !== currentUserId)) return;
    setVisibility(next);
  };

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    getCurrentUserId().then(setCurrentUserId).catch(() => setCurrentUserId(null));
  }, []);

  const getRecipeTranslation = (source: RecipeModel, language: RecipeLanguage): RecipeTranslation | null => {
    const baseLanguage = normalizeRecipeLanguage(source.baseLanguage);
    return source.translations?.[language] || source.translations?.[baseLanguage] || null;
  };

  const resetFormFromRecipe = (source: RecipeModel, language: RecipeLanguage = contentLanguage) => {
    const translation = getRecipeTranslation(source, language);
    const descriptionText = translation?.description || source.description || "";
    const linkFromDescription = looksLikeLink(descriptionText) ? descriptionText : "";

    setTitle(translation?.title || source.title || "");
    setShortDescription(translation?.shortDescription || source.shortDescription || "");
    setRecipeLink(linkFromDescription);
    setInstructions(translation?.instructions || source.instructions || (linkFromDescription ? "" : descriptionText));
    setNotes(source.notes || "");
    setServings(source.servings && source.servings > 0 ? source.servings : 2);
    setVisibility(source.visibility || "private");
    setShareToken(source.shareToken || "");
    setInvitedEmailsDraft("");
    setShowInvitedAccessEditor(false);
    setShareCopyMessage("");
    setAccessNotice("");
    setImage(source.image || "");
    setIngredients(source.ingredients || []);
    setSelectedTags(source.tags || source.categories || []);
    setTranslationNotice("");
  };

  const loadRecipe = async () => {
    setIsLoading(true);
    setProductSuggestions(loadProductSuggestions());

    try {
      const localRecipe = loadLocalRecipes().find((item) => item.id === recipeId) || null;
      const preferredLocaleLanguage = normalizeRecipeLanguage(locale);

      if (!isSupabaseConfigured()) {
        setRecipe(localRecipe);
        if (localRecipe) {
          const preferred =
            localRecipe.translations?.[preferredLocaleLanguage]
              ? preferredLocaleLanguage
              : normalizeRecipeLanguage(localRecipe.baseLanguage);
          setContentLanguage(preferred);
          resetFormFromRecipe(localRecipe, preferred);
        }
        return;
      }

      if (localRecipe) {
        setRecipe(localRecipe);
        const preferred =
          localRecipe.translations?.[preferredLocaleLanguage]
            ? preferredLocaleLanguage
            : normalizeRecipeLanguage(localRecipe.baseLanguage);
        setContentLanguage(preferred);
        resetFormFromRecipe(localRecipe, preferred);
        setIsReportedHidden(false);
        if (!localRecipe.ownerId) {
          return;
        }
      }

      const data = await getRecipeById(recipeId, currentUserId, sharedTokenFromQuery || null);
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
      if (data) {
        const preferred =
          data.translations?.[preferredLocaleLanguage]
            ? preferredLocaleLanguage
            : normalizeRecipeLanguage(data.baseLanguage);
        setContentLanguage(preferred);
        resetFormFromRecipe(data, preferred);
        if (data.visibility === "invited" && currentUserId && data.ownerId === currentUserId) {
          try {
            const entries = await listRecipeAccessEmails(currentUserId, data.id);
            setInvitedEmailsDraft(entries.map((entry) => entry.email).join("\n"));
          } catch {
            setInvitedEmailsDraft("");
          }
        }
      }
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
  }, [recipeId, currentUserId, sharedTokenFromQuery, locale]);

  const addIngredient = () => {
    setIngredients((prev) => [...prev, { name: "", amount: 0, unit: UNITS[0] }]);
  };

  const removeIngredient = (index: number) => {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  };

  const updateIngredient = (index: number, field: "name" | "amount" | "unit", value: string | number) => {
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

    const normalizedIngredients = ingredients
      .filter((item) => item.name.trim())
      .map((item) => ({
        ingredientId: item.ingredientId,
        name: item.name.trim(),
        amount: item.unit === "по вкусу" ? 0 : Math.max(0, item.amount || 0),
        unit: item.unit || UNITS[0],
        note: item.note,
        optional: Boolean(item.optional),
      }));
    const normalizedTags = Array.from(new Set(selectedTags.map((tag) => tag.trim()).filter(Boolean)));
    const normalizedRecipeLink = normalizeLink(recipeLink);
    const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
    const isBaseLanguageEditing = contentLanguage === baseLanguage;
    const baseTranslation = getRecipeTranslation(recipe, baseLanguage);
    const nextTranslation: RecipeTranslation = {
      language: contentLanguage,
      title: title.trim(),
      shortDescription: shortDescription.trim() || undefined,
      description: normalizedRecipeLink || undefined,
      instructions: instructions.trim() || undefined,
      updatedAt: new Date().toISOString(),
      isAutoGenerated: false,
    };
    const nextTranslations: Partial<Record<RecipeLanguage, RecipeTranslation>> = {
      ...(recipe.translations || {}),
      [contentLanguage]: nextTranslation,
    };
    const nextBaseTitle = isBaseLanguageEditing
      ? nextTranslation.title
      : (baseTranslation?.title || recipe.title || nextTranslation.title);
    const nextBaseShortDescription = isBaseLanguageEditing
      ? (nextTranslation.shortDescription || "")
      : (baseTranslation?.shortDescription || recipe.shortDescription || "");
    const nextBaseDescription = isBaseLanguageEditing
      ? (nextTranslation.description || "")
      : (baseTranslation?.description || recipe.description || "");
    const nextBaseInstructions = isBaseLanguageEditing
      ? (nextTranslation.instructions || "")
      : (baseTranslation?.instructions || recipe.instructions || "");

    const names = normalizedIngredients.map((item) => item.name);
    if (names.length > 0) {
      appendProductSuggestions(names);
      setProductSuggestions(loadProductSuggestions());
    }

    try {
      setIsSaving(true);

      const isLocalRecipe = !recipe.ownerId;
      const canManageVisibility = Boolean(currentUserId && recipe.ownerId === currentUserId);
      const normalizedVisibility: RecipeVisibility = canManageVisibility ? visibility : "private";
      const normalizedShareToken =
        normalizedVisibility === "link" ? (shareToken.trim() || recipe.shareToken || generateShareToken()) : "";
      const invitedEmails =
        normalizedVisibility === "invited" ? parseInvitedEmails(invitedEmailsDraft) : [];

      if (!isSupabaseConfigured() || isLocalRecipe) {
        const updated: RecipeModel = {
          ...recipe,
          title: nextBaseTitle,
          shortDescription: nextBaseShortDescription,
          description: nextBaseDescription,
          instructions: nextBaseInstructions,
          notes: notes.trim(),
          ingredients: normalizedIngredients,
          servings: servings > 0 ? servings : 2,
          image: image.trim(),
          baseLanguage,
          translations: nextTranslations,
          visibility: "private",
          shareToken: undefined,
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
        title: nextBaseTitle,
        shortDescription: nextBaseShortDescription,
        description: nextBaseDescription,
        instructions: nextBaseInstructions,
        notes: notes.trim(),
        ingredients: normalizedIngredients,
        servings: servings > 0 ? servings : 2,
        image: image.trim(),
        baseLanguage,
        translations: nextTranslations,
        visibility: normalizedVisibility,
        shareToken: normalizedShareToken || undefined,
        categories: normalizedTags,
        tags: normalizedTags,
      });

      if (normalizedVisibility === "invited") {
        await replaceRecipeAccessByEmail(currentUserId, recipe.id, invitedEmails);
        if (invitedEmails.length > 0) {
          const inviteResult = await sendRecipeAccessInvites(recipe.id, invitedEmails);
          if (inviteResult.failed.length > 0) {
            const failedEmails = inviteResult.failed.map((item) => item.email).join(", ");
            setAccessNotice(`Часть приглашений не отправлена: ${failedEmails}`);
          } else {
            setAccessNotice(`Приглашения отправлены: ${inviteResult.sent.length}`);
          }
        } else {
          setAccessNotice("Список приглашённых обновлен.");
        }
      } else {
        setAccessNotice("");
      }

      let savedTranslation: RecipeTranslation = nextTranslation;
      try {
        savedTranslation = await upsertRecipeTranslation(currentUserId, recipe.id, nextTranslation);
      } catch (error) {
        if (!isMissingRecipeTranslationsTableError(error)) {
          throw error;
        }
      }

      const finalizedRecipe: RecipeModel = {
        ...(normalizedVisibility === "link" && normalizedShareToken
          ? { ...updated, shareToken: normalizedShareToken }
          : updated),
        baseLanguage,
        translations: {
          ...(updated.translations || {}),
          ...(recipe.translations || {}),
          [contentLanguage]: savedTranslation,
        },
      };
      upsertRecipeInLocalCache(finalizedRecipe);
      setRecipe(finalizedRecipe);
      setIsEditing(false);
    } catch (error) {
      if (isMissingRecipesTableError(error)) {
        const updatedLocal: RecipeModel = {
          ...recipe,
          ownerId: "",
          title: nextBaseTitle,
          shortDescription: nextBaseShortDescription,
          description: nextBaseDescription,
          instructions: nextBaseInstructions,
          notes: notes.trim(),
          ingredients: normalizedIngredients,
          servings: servings > 0 ? servings : 2,
          image: image.trim(),
          baseLanguage,
          translations: nextTranslations,
          visibility: "private",
          shareToken: undefined,
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

  const switchContentLanguage = (nextLanguage: RecipeLanguage) => {
    setContentLanguage(nextLanguage);
    if (recipe) {
      resetFormFromRecipe(recipe, nextLanguage);
    }
  };

  const createTranslationDraft = async () => {
    if (!recipe) return;
    if (!canEdit) return;
    if (recipe.translations?.[contentLanguage]) {
      setTranslationNotice("Перевод уже существует.");
      return;
    }

    const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
    const base = getRecipeTranslation(recipe, baseLanguage);
    const fallbackDraft: RecipeTranslation = {
      language: contentLanguage,
      title: (base?.title || recipe.title || "").trim(),
      shortDescription: (base?.shortDescription || recipe.shortDescription || "").trim() || undefined,
      description: (base?.description || recipe.description || "").trim() || undefined,
      instructions: (base?.instructions || recipe.instructions || "").trim() || undefined,
      updatedAt: new Date().toISOString(),
      isAutoGenerated: true,
    };

    if (!fallbackDraft.title) {
      setTranslationNotice("Невозможно создать перевод без названия.");
      return;
    }

    try {
      setIsCreatingTranslation(true);
      let draft = fallbackDraft;
      let notice = "Черновик перевода создан.";

      try {
        const aiDraft = await getRecipeTranslationDraft({
          sourceLanguage: baseLanguage,
          targetLanguage: contentLanguage,
          title: fallbackDraft.title,
          shortDescription: fallbackDraft.shortDescription,
          description: fallbackDraft.description,
          instructions: fallbackDraft.instructions,
        });

        const translated = aiDraft.translation;
        draft = {
          ...fallbackDraft,
          title: (translated.title || fallbackDraft.title || "").trim(),
          shortDescription:
            (translated.shortDescription || fallbackDraft.shortDescription || "").trim() || undefined,
          description: (translated.description || fallbackDraft.description || "").trim() || undefined,
          instructions: (translated.instructions || fallbackDraft.instructions || "").trim() || undefined,
          updatedAt: new Date().toISOString(),
          isAutoGenerated: true,
        };
        notice = aiDraft.message?.trim() || "Перевод создан. Проверьте текст.";
      } catch {
        notice = "ИИ недоступен. Создан черновик из исходного текста.";
      }

      const nextTranslations = { ...(recipe.translations || {}), [contentLanguage]: draft };

      if (!isSupabaseConfigured() || !recipe.ownerId || !currentUserId) {
        const localUpdated: RecipeModel = {
          ...recipe,
          translations: nextTranslations,
        };
        upsertRecipeInLocalCache(localUpdated);
        setRecipe(localUpdated);
        resetFormFromRecipe(localUpdated, contentLanguage);
        setTranslationNotice(notice);
        return;
      }

      const saved = await upsertRecipeTranslation(currentUserId, recipe.id, draft);
      const updatedRecipe: RecipeModel = {
        ...recipe,
        translations: { ...(recipe.translations || {}), [contentLanguage]: saved },
      };
      upsertRecipeInLocalCache(updatedRecipe);
      setRecipe(updatedRecipe);
      resetFormFromRecipe(updatedRecipe, contentLanguage);
      setTranslationNotice(notice);
    } catch (error) {
      const text = toErrorText(error, "Не удалось создать перевод.");
      setTranslationNotice(text);
    } finally {
      setIsCreatingTranslation(false);
    }
  };

  const copyToMine = async () => {
    if (!recipe) return;
    const shouldShowFirstRecipeOverlay =
      typeof window !== "undefined" &&
      (localStorage.getItem(RECIPES_FIRST_FLOW_KEY) === "1" ||
        localStorage.getItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY) !== "1");
    const sourceTitleKey = normalizeRecipeTitle(recipe.title || "");
    const findExistingMineLocal = (): RecipeModel | null => {
      const existing = loadLocalRecipes().find(
        (item) => normalizeRecipeTitle(item.title || "") === sourceTitleKey
      );
      return existing || null;
    };

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
      const existingLocal = findExistingMineLocal();
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
      const existingLocal = findExistingMineLocal();
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
        const existingLocal = findExistingMineLocal();
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
      const text = toErrorText(error, "Не удалось скопировать рецепт.");
      alert(text);
    }
  };

  const copyShareLink = async () => {
    if (!recipe) return;
    const token = (shareToken || recipe.shareToken || "").trim();
    if (!token) {
      setShareCopyMessage("Сначала сгенерируйте токен и сохраните рецепт.");
      return;
    }

    if (typeof window === "undefined") return;
    const shareUrl = `${window.location.origin}/recipes/${encodeURIComponent(recipe.id)}?share=${encodeURIComponent(token)}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopyMessage("Ссылка скопирована.");
      window.setTimeout(() => setShareCopyMessage(""), 1200);
    } catch {
      setShareCopyMessage("Не удалось скопировать. Скопируйте ссылку из строки браузера.");
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

  const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
  const activeTranslation = getRecipeTranslation(recipe, contentLanguage);
  const displayTitle = activeTranslation?.title || recipe.title || "";
  const displayShortDescription = activeTranslation?.shortDescription || recipe.shortDescription || "";
  const displayDescription = activeTranslation?.description || recipe.description || "";
  const displayInstructions = activeTranslation?.instructions || recipe.instructions || "";
  const recipeLinkView = looksLikeLink(displayDescription) ? normalizeLink(displayDescription) : "";
  const cookingText = displayInstructions || (recipeLinkView ? "" : displayDescription || "");
  const showCopyButton = recipe.visibility === "public" && (!currentUserId || recipe.ownerId !== currentUserId);
  const showReportButton = recipe.visibility === "public" && (!currentUserId || recipe.ownerId !== currentUserId);
  const canChangeVisibility = Boolean(recipe.ownerId && currentUserId && recipe.ownerId === currentUserId);
  const recipeImage = resolveRecipeImage(recipe);
  const canCreateTranslation = canEdit && !recipe.translations?.[contentLanguage] && contentLanguage !== baseLanguage;

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
              disabled={isSaving}
            >
              {isSaving ? "Сохранение..." : "Сохранить"}
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

      <div className="card" style={{ marginBottom: "14px", padding: "10px 12px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted" style={{ marginRight: "4px" }}>Язык рецепта:</span>
          {RECIPE_LANGUAGES.map((language) => {
            const exists = Boolean(recipe.translations?.[language]) || language === baseLanguage;
            const active = contentLanguage === language;
            return (
              <button
                key={language}
                type="button"
                className={`btn ${active ? "btn-primary" : ""}`}
                onClick={() => switchContentLanguage(language)}
                style={{ padding: "4px 10px", fontSize: "12px" }}
                title={exists ? "Версия доступна" : "Перевода пока нет"}
              >
                {LANGUAGE_LABELS[language]}{exists ? "" : " *"}
              </button>
            );
          })}

          {canCreateTranslation ? (
            <button
              type="button"
              className="btn"
              onClick={createTranslationDraft}
              disabled={isCreatingTranslation}
            >
              {isCreatingTranslation ? "Создаю перевод..." : `Создать перевод (${LANGUAGE_LABELS[contentLanguage]})`}
            </button>
          ) : null}
        </div>
        {translationNotice ? (
          <p className="muted" style={{ margin: "8px 0 0 0" }}>{translationNotice}</p>
        ) : null}
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
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Доступ</label>
              <div style={{ display: "grid", gap: "8px" }}>
                {ACCESS_OPTIONS.map((option) => {
                  const disabled = !canChangeVisibility && option.value !== "private";
                  const isActive = visibility === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`btn ${isActive ? "btn-primary" : ""}`}
                      onClick={() => handleVisibilityChange(option.value)}
                      disabled={disabled}
                      style={{
                        justifyContent: "flex-start",
                        textAlign: "left",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: "2px",
                      }}
                    >
                      <span>{option.label}</span>
                      <span style={{ fontSize: "12px", opacity: 0.85 }}>{option.description}</span>
                    </button>
                  );
                })}
              </div>
              {!canChangeVisibility ? (
                <p className="muted" style={{ margin: "8px 0 0 0" }}>
                  Режим доступа может менять только владелец рецепта.
                </p>
              ) : null}

              {visibility === "link" ? (
                <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button type="button" className="btn" onClick={() => setShareToken(generateShareToken())}>
                      Сгенерировать ссылку
                    </button>
                    <button type="button" className="btn" onClick={copyShareLink}>
                      Скопировать ссылку
                    </button>
                  </div>
                  {shareCopyMessage ? (
                    <p className="muted" style={{ margin: 0 }}>
                      {shareCopyMessage}
                    </p>
                  ) : null}
                  {shareToken || recipe.shareToken ? (
                    <p className="muted" style={{ margin: 0 }}>
                      Токен: {(shareToken || recipe.shareToken || "").slice(0, 12)}...
                    </p>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>
                      Сгенерируйте ссылку и сохраните рецепт.
                    </p>
                  )}
                </div>
              ) : null}

              {visibility === "invited" ? (
                <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setShowInvitedAccessEditor((prev) => !prev)}
                  >
                    Управлять доступом
                  </button>
                  {showInvitedAccessEditor ? (
                    <div style={{ display: "grid", gap: "6px" }}>
                      <textarea
                        className="input"
                        rows={4}
                        value={invitedEmailsDraft}
                        onChange={(e) => setInvitedEmailsDraft(e.target.value)}
                        placeholder="email пользователей, по одному в строке"
                        style={{ minHeight: "88px", resize: "vertical" }}
                      />
                      <p className="muted" style={{ margin: 0 }}>
                        Приглашения отправляются на email, доступ выдается после входа в аккаунт.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {accessNotice ? (
                <p className="muted" style={{ margin: "8px 0 0 0" }}>
                  {accessNotice}
                </p>
              ) : null}
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
                  {visibility !== "private" ? (
                    <p className="muted" style={{ marginTop: "8px" }}>
                      Если источник не указан, ответственность за публикацию остается на вас.
                    </p>
                  ) : null}
                </div>

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

          <h1 className="h1" style={{ marginBottom: "10px" }}>{displayTitle}</h1>

          {displayShortDescription && (
            <p style={{ marginBottom: "16px", color: "var(--text-secondary)" }}>
              <LinkifiedText text={displayShortDescription} />
            </p>
          )}

          <p style={{ marginBottom: "10px" }}>
            <strong>Порции:</strong> {recipe.servings || 2}
          </p>

          <p style={{ marginBottom: "16px" }}>
            <strong>Видимость:</strong> {VISIBILITY_LABELS[recipe.visibility || "private"]}
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
                    {(() => {
                      const localizedName = getIngredientNameById(item.ingredientId || "", locale, item.name);
                      return item.unit === "по вкусу"
                        ? `${localizedName} — по вкусу`
                        : `${item.amount} ${item.unit} ${localizedName}`;
                    })()}
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
