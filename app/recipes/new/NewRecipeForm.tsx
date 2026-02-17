"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { appendProductSuggestions, loadProductSuggestions } from "../../lib/productSuggestions";
import ProductAutocompleteInput from "../../components/ProductAutocompleteInput";
import {
  createRecipe,
  getCurrentUserId,
  upsertRecipeInLocalCache,
  type Ingredient,
  type RecipeModel,
  type RecipeVisibility,
} from "../../lib/recipesSupabase";
import { isSupabaseConfigured } from "../../lib/supabaseClient";
import { RECIPE_TAGS } from "../../lib/recipeTags";
import {
  getIngredientHints,
  importRecipeByPhoto,
  importRecipeByUrl,
  type ImportedRecipeDraft,
  getRecipeImage,
  getServingsHint,
  getTagHints,
} from "../../lib/aiAssistantClient";

const UNITS = ["г", "кг", "мл", "л", "шт", "ч.л.", "ст.л.", "по вкусу"];
const MAX_IMPORT_PHOTOS = 8;
const IMPORT_MAX_SIDE = 1800;
const IMPORT_QUALITY = 0.88;
const RECIPES_FIRST_FLOW_KEY = "recipesFirstFlowActive";
const FIRST_RECIPE_ADDED_KEY = "recipes:first-added-recipe-id";
const FIRST_RECIPE_SUCCESS_PENDING_KEY = "recipes:first-success-pending";
const FIRST_RECIPE_CREATE_FLOW_KEY = "recipes:first-create-flow";

type IngredientHintsMap = Record<number, string[]>;
type ImportMode = "url" | "photo";
type ReviewHintsMap = Record<number, boolean>;
type ImportStatus = "idle" | "loading" | "success" | "error";

const SUPPORTED_IMPORT_DOMAINS = [
  "russianfood.com",
  "eda.ru",
  "povarenok.ru",
  "gotovim.ru",
  "gastronom.ru",
] as const;

const normalizeImportUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const isSupportedImportUrl = (normalizedUrl: string): boolean => {
  try {
    const host = new URL(normalizedUrl).hostname.toLowerCase();
    return SUPPORTED_IMPORT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
};

const hasImportedContent = (draft: ImportedRecipeDraft | null): boolean => {
  if (!draft) return false;
  if (draft.title?.trim()) return true;
  if (draft.instructions?.trim()) return true;
  return (draft.ingredients || []).some((item) => item.name?.trim().length > 0);
};

const sanitizeImportIssue = (issue: string): string => {
  const value = issue.trim();
  if (!value) return "";
  const normalized = value.toLowerCase();
  if (
    normalized.includes("openrouter") ||
    normalized.includes("fal_key") ||
    normalized.includes("api_key") ||
    normalized.includes("env") ||
    normalized.includes(".env")
  ) {
    return "Импорт по фото временно недоступен. Попробуйте позже или заполните вручную.";
  }
  return value;
};

const sanitizeImportIssues = (issues: string[]): string[] =>
  Array.from(new Set(issues.map((issue) => sanitizeImportIssue(issue)).filter(Boolean)));

interface NewRecipeFormProps {
  initialFirstCreate?: boolean;
}

export default function NewRecipeForm({ initialFirstCreate }: NewRecipeFormProps) {
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [shortDescription, setShortDescription] = useState("");
  const [recipeLink, setRecipeLink] = useState("");
  const [instructions, setInstructions] = useState("");
  const [notes, setNotes] = useState("");
  const [image, setImage] = useState("");
  const [servings, setServings] = useState(2);
  const [visibility, setVisibility] = useState<RecipeVisibility>("private");
  const [publishConsentChecked, setPublishConsentChecked] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([{ name: "", amount: 0, unit: UNITS[0] }]);
  const [productSuggestions] = useState<string[]>(() => loadProductSuggestions());
  const [isSaving, setIsSaving] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [aiAction, setAiAction] = useState<
    "ingredients" | "tags" | "servings" | "image" | "import_url" | "import_photo" | null
  >(null);
  const [aiMessage, setAiMessage] = useState("");
  const [ingredientHints, setIngredientHints] = useState<IngredientHintsMap>({});
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [suggestedServings, setSuggestedServings] = useState<number | null>(null);
  const [showImportTools, setShowImportTools] = useState(false);
  const [showAiTools, setShowAiTools] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("url");
  const [importUrl, setImportUrl] = useState("");
  const [importPhotoDataUrls, setImportPhotoDataUrls] = useState<string[]>([]);
  const [importPhotoNames, setImportPhotoNames] = useState<string[]>([]);
  const [importIssues, setImportIssues] = useState<string[]>([]);
  const [importStatus, setImportStatus] = useState<ImportStatus>("idle");
  const [importStatusMessage, setImportStatusMessage] = useState("");
  const [reviewHints, setReviewHints] = useState<ReviewHintsMap>({});
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const stepOneRef = useRef<HTMLDivElement | null>(null);
  const hasCoreInput = title.trim().length > 0 || ingredients.some((item) => item.name.trim().length > 0);

  const optimizeImageFile = (file: File): Promise<string> =>
    new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const source = String(reader.result || "");
        if (!source.startsWith("data:image/")) {
          resolve(source);
          return;
        }

        const image = new Image();
        image.onload = () => {
          const maxSide = Math.max(image.width, image.height);
          if (maxSide <= IMPORT_MAX_SIDE) {
            resolve(source);
            return;
          }

          const scale = IMPORT_MAX_SIDE / maxSide;
          const width = Math.max(1, Math.round(image.width * scale));
          const height = Math.max(1, Math.round(image.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(source);
            return;
          }
          ctx.drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", IMPORT_QUALITY));
        };
        image.onerror = () => resolve(source);
        image.src = source;
      };
      reader.readAsDataURL(file);
    });

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    getCurrentUserId().then(setCurrentUserId).catch(() => setCurrentUserId(null));
  }, []);

  const addIngredient = () => {
    setIngredients((prev) => [...prev, { name: "", amount: 0, unit: UNITS[0] }]);
  };

  const removeIngredient = (index: number) => {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
    setReviewHints({});
  };

  const updateIngredient = (index: number, field: keyof Ingredient, value: string | number) => {
    setIngredients((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
    setReviewHints((prev) => {
      if (!prev[index]) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleImageUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      setImage(String(reader.result || ""));
    };
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
        const cacheBust = `_ts=${Date.now()}`;
        const freshUrl = data.imageUrl.includes("?")
          ? `${data.imageUrl}&${cacheBust}`
          : `${data.imageUrl}?${cacheBust}`;
        setImage(freshUrl);
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

  const applyImportedDraft = (draft: ImportedRecipeDraft | null) => {
    if (!draft) return;
    if (draft.title?.trim()) setTitle(draft.title.trim());
    if (draft.shortDescription?.trim()) setShortDescription(draft.shortDescription.trim());
    if (draft.instructions?.trim()) setInstructions(draft.instructions.trim());
    if (draft.image?.trim()) setImage(draft.image.trim());
    if (draft.servings && draft.servings > 0) setServings(Math.round(draft.servings));

    const importedIngredients = (draft.ingredients || [])
      .map((item) => ({
        name: item.name?.trim() || "",
        amount: item.unit === "по вкусу" ? 0 : Math.max(0, Number(item.amount || 0)),
        unit: item.unit || UNITS[0],
      }))
      .filter((item) => item.name.length > 0);

    if (importedIngredients.length > 0) {
      setIngredients(importedIngredients);
      appendProductSuggestions(importedIngredients.map((item) => item.name));
    }

    const hints: ReviewHintsMap = {};
    for (let i = 0; i < (draft.ingredients || []).length; i += 1) {
      if (draft.ingredients[i]?.needsReview) hints[i] = true;
    }
    setReviewHints(hints);

    const allowed = new Set(RECIPE_TAGS as readonly string[]);
    const tags = (draft.tags || []).filter((tag) => allowed.has(tag));
    if (tags.length > 0) setSelectedTags(tags);
  };

  const scrollToStepOne = () => {
    requestAnimationFrame(() => {
      stepOneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const clearImportPhotos = () => {
    setImportPhotoDataUrls([]);
    setImportPhotoNames([]);
    setImportIssues([]);
    setImportStatus("idle");
    setImportStatusMessage("");
    if (photoInputRef.current) {
      photoInputRef.current.value = "";
    }
    if (cameraInputRef.current) {
      cameraInputRef.current.value = "";
    }
  };

  const removeImportPhotoAt = (index: number) => {
    setImportPhotoDataUrls((prev) => prev.filter((_, i) => i !== index));
    setImportPhotoNames((prev) => prev.filter((_, i) => i !== index));
  };

  const handleImportByUrl = async () => {
    const normalizedUrl = normalizeImportUrl(importUrl);
    if (!importUrl.trim()) {
      setImportStatus("error");
      setImportStatusMessage("Вставьте ссылку на рецепт.");
      setImportIssues([]);
      return;
    }
    if (!normalizedUrl) {
      setImportStatus("error");
      setImportStatusMessage("Введите корректную ссылку.");
      setImportIssues([]);
      return;
    }
    if (!isSupportedImportUrl(normalizedUrl)) {
      setImportStatus("error");
      setImportStatusMessage("Эта ссылка не поддерживается.");
      setImportIssues([]);
      return;
    }

    try {
      setAiAction("import_url");
      setImportStatus("loading");
      setImportStatusMessage("Импортирую...");
      setImportIssues([]);
      const data = await importRecipeByUrl({
        url: normalizedUrl,
        knownProducts: productSuggestions,
      });
      applyImportedDraft(data.recipe);
      setImportIssues(sanitizeImportIssues(Array.isArray(data.issues) ? data.issues : []));
      if (hasImportedContent(data.recipe)) {
        setImportStatus("success");
        setImportStatusMessage("Импортировано. Проверьте и сохраните.");
        scrollToStepOne();
      } else {
        setImportStatus("error");
        setImportStatusMessage("Не удалось импортировать рецепт по ссылке. Попробуйте другую ссылку или заполните вручную.");
      }
    } catch (error) {
      console.error("[recipes/new] import by URL failed", error);
      setImportStatus("error");
      setImportStatusMessage("Не удалось импортировать рецепт по ссылке. Попробуйте другую ссылку или заполните вручную.");
    } finally {
      setAiAction(null);
    }
  };

  const handleImportPhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/")).slice(0, MAX_IMPORT_PHOTOS);
    if (imageFiles.length === 0) {
      setImportStatus("error");
      setImportStatusMessage("Выберите фото рецепта.");
      return;
    }

    setImportStatus("idle");
    setImportStatusMessage("");
    setImportIssues([]);
    Promise.all(imageFiles.map((file) => optimizeImageFile(file))).then((images) => {
      setImportPhotoDataUrls(images.filter(Boolean));
      setImportPhotoNames(imageFiles.map((file) => file.name));
      setImportStatus("idle");
      setImportStatusMessage(`Загружено фото: ${imageFiles.length}. Нажмите «Распознать».`);
    });
  };

  const handleCameraCaptureChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      setImportStatus("error");
      setImportStatusMessage("Не удалось получить фото с камеры.");
      return;
    }

    setImportStatus("idle");
    setImportStatusMessage("");
    setImportIssues([]);
    Promise.all(imageFiles.map((file) => optimizeImageFile(file))).then((images) => {
      setImportPhotoDataUrls((prev) => [...prev, ...images].slice(0, MAX_IMPORT_PHOTOS));
      setImportPhotoNames((prev) => [...prev, ...imageFiles.map((file) => file.name)].slice(0, MAX_IMPORT_PHOTOS));
      setImportStatus("idle");
      setImportStatusMessage("Фото с камеры добавлено. Нажмите «Распознать».");
    });
  };

  const handleImportByPhoto = async () => {
    if (importPhotoDataUrls.length === 0) {
      setImportStatus("error");
      setImportStatusMessage("Сначала загрузите хотя бы одно фото рецепта.");
      setImportIssues([]);
      return;
    }

    try {
      setAiAction("import_photo");
      setImportStatus("loading");
      setImportStatusMessage("Распознаю...");
      setImportIssues([]);
      const data = await importRecipeByPhoto({
        imageDataUrls: importPhotoDataUrls,
        knownProducts: productSuggestions,
      });
      applyImportedDraft(data.recipe);
      setImportIssues(sanitizeImportIssues(Array.isArray(data.issues) ? data.issues : []));
      if (hasImportedContent(data.recipe)) {
        setImportStatus("success");
        setImportStatusMessage("Рецепт распознан, проверьте и сохраните.");
        scrollToStepOne();
      } else {
        setImportStatus("error");
        setImportStatusMessage("Не удалось распознать фото. Попробуйте другое фото или заполните вручную.");
      }
    } catch (error) {
      console.error("[recipes/new] import by photo failed", error);
      setImportStatus("error");
      setImportStatusMessage("Не удалось распознать фото. Попробуйте другое фото или заполните вручную.");
    } finally {
      setAiAction(null);
    }
  };

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

  const saveRecipe = async () => {
    if (!title.trim()) {
      alert("Название рецепта обязательно");
      return;
    }

    if (visibility === "public" && !publishConsentChecked) {
      alert("Подтвердите право на публикацию рецепта.");
      return;
    }

    const normalizedLinkRaw = recipeLink.trim();
    const normalizedLink = normalizedLinkRaw
      ? (/^https?:\/\//i.test(normalizedLinkRaw) ? normalizedLinkRaw : `https://${normalizedLinkRaw}`)
      : "";

    const normalizedTags = Array.from(new Set(selectedTags.map((tag) => tag.trim()).filter(Boolean)));

    const normalizedIngredients = ingredients
      .filter((item) => item.name.trim())
      .map((item) => ({
        name: item.name.trim(),
        amount: item.unit === "по вкусу" ? 0 : Math.max(0, item.amount || 0),
        unit: item.unit || UNITS[0],
      }));

    const names = normalizedIngredients.map((item) => item.name);
    if (names.length > 0) {
      appendProductSuggestions(names);
    }

    try {
      setIsSaving(true);
      const shouldShowFirstRecipeOverlay =
        typeof window !== "undefined" &&
        (initialFirstCreate ||
          localStorage.getItem(RECIPES_FIRST_FLOW_KEY) === "1" ||
          localStorage.getItem(FIRST_RECIPE_CREATE_FLOW_KEY) === "1");

      if (!isSupabaseConfigured() || !currentUserId) {
        const localRecipe: RecipeModel = {
          id: crypto.randomUUID(),
          ownerId: "",
          title: title.trim(),
          shortDescription: shortDescription.trim(),
          description: normalizedLink,
          instructions: instructions.trim(),
          notes: notes.trim(),
          image: image.trim(),
          ingredients: normalizedIngredients,
          servings: servings > 0 ? servings : 2,
          visibility: "private",
          categories: normalizedTags,
          tags: normalizedTags,
        };

        upsertRecipeInLocalCache(localRecipe);
        if (shouldShowFirstRecipeOverlay && typeof window !== "undefined") {
          localStorage.setItem(FIRST_RECIPE_ADDED_KEY, localRecipe.id);
          localStorage.setItem(FIRST_RECIPE_SUCCESS_PENDING_KEY, "1");
          router.push(`/recipes?firstAdded=1&recipe=${encodeURIComponent(localRecipe.id)}`);
        } else {
          router.push(`/recipes/${localRecipe.id}`);
        }
        return;
      }

      const created = await createRecipe(currentUserId, {
        title: title.trim(),
        shortDescription: shortDescription.trim(),
        description: normalizedLink,
        instructions: instructions.trim(),
        notes: notes.trim(),
        image: image.trim(),
        ingredients: normalizedIngredients,
        servings: servings > 0 ? servings : 2,
        visibility: visibility || "private",
        categories: normalizedTags,
        tags: normalizedTags,
      });

      upsertRecipeInLocalCache(created);
      if (shouldShowFirstRecipeOverlay && typeof window !== "undefined") {
        localStorage.setItem(FIRST_RECIPE_ADDED_KEY, created.id);
        localStorage.setItem(FIRST_RECIPE_SUCCESS_PENDING_KEY, "1");
        router.push(`/recipes?firstAdded=1&recipe=${encodeURIComponent(created.id)}`);
      } else {
        router.push(`/recipes/${created.id}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось сохранить рецепт.";
      alert(text);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ padding: "20px", maxWidth: "860px", margin: "0 auto" }}>
      <div style={{ marginBottom: "20px" }}>
        <button className="btn" onClick={() => router.push("/recipes")}>
          ← Назад к рецептам
        </button>
      </div>

      <h1 className="h1" style={{ marginBottom: "20px" }}>
        Новый рецепт
      </h1>

      {!currentUserId && (
        <p className="muted" style={{ marginBottom: "14px" }}>
          Режим черновика: рецепт сохранится локально на этом устройстве.
        </p>
      )}

      {aiMessage && (
        <p className="muted" style={{ marginBottom: "14px" }}>
          Отто: {aiMessage}
        </p>
      )}

      <p className="muted" style={{ marginTop: "-4px", marginBottom: "14px" }}>
        Быстрый старт: достаточно названия и ингредиентов. Остальное можно добавить позже.
      </p>

      <div className="card" style={{ marginBottom: "14px", padding: "12px", background: "var(--background-secondary)" }}>
        <button className="btn" type="button" onClick={() => setShowImportTools((prev) => !prev)}>
          {showImportTools ? "Скрыть импорт" : "Импортировать рецепт (необязательно)"}
        </button>

        {showImportTools ? (
          <div style={{ marginTop: "10px" }}>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
              <button
                className={`btn ${importMode === "url" ? "btn-primary" : ""}`}
                onClick={() => setImportMode("url")}
                type="button"
              >
                Импорт по ссылке
              </button>
              <button
                className={`btn ${importMode === "photo" ? "btn-primary" : ""}`}
                onClick={() => setImportMode("photo")}
                type="button"
              >
                Импорт по фото
              </button>
            </div>

            {importMode === "url" ? (
              <div style={{ display: "grid", gap: "8px" }}>
                <input
                  className="input"
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="Вставьте ссылку на рецепт"
                />
                <button className="btn btn-primary" onClick={handleImportByUrl} disabled={aiAction === "import_url"}>
                  {aiAction === "import_url" ? "Импортирую..." : "Импортировать"}
                </button>
              </div>
            ) : null}

            {importMode === "photo" ? (
              <div style={{ display: "grid", gap: "8px" }}>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleImportPhotoChange}
                  className="input"
                />
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleCameraCaptureChange}
                  style={{ display: "none" }}
                />
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button className="btn" type="button" onClick={() => cameraInputRef.current?.click()}>
                    Снять с камеры
                  </button>
                  {importPhotoDataUrls.length > 0 ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={clearImportPhotos}
                    >
                      Очистить фото
                    </button>
                  ) : null}
                </div>
                {importPhotoDataUrls.length > 0 ? (
                  <div style={{ display: "grid", gap: "6px" }}>
                    <p className="muted" style={{ margin: 0 }}>
                      Фото для распознавания: {importPhotoDataUrls.length}
                    </p>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {importPhotoNames.map((name, index) => (
                        <button
                          key={`${name}-${index}`}
                          type="button"
                          className="btn"
                          onClick={() => removeImportPhotoAt(index)}
                          style={{ padding: "4px 8px", fontSize: "12px" }}
                          title="Удалить фото"
                        >
                          {name || `Фото ${index + 1}`} ×
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <button className="btn btn-primary" onClick={handleImportByPhoto} disabled={aiAction === "import_photo"}>
                  {aiAction === "import_photo" ? "Распознаю..." : "Распознать"}
                </button>
              </div>
            ) : null}

            {importStatusMessage ? (
              <p
                style={{
                  marginTop: "8px",
                  marginBottom: 0,
                  color:
                    importStatus === "error"
                      ? "var(--danger)"
                      : importStatus === "success"
                        ? "var(--accent)"
                        : "var(--text-secondary)",
                }}
              >
                {importStatusMessage}
              </p>
            ) : null}

            {importIssues.length > 0 ? (
              <div style={{ marginTop: "8px" }}>
                <p className="muted" style={{ marginBottom: "6px" }}>Проверьте после импорта:</p>
                <ul style={{ margin: 0, paddingLeft: "20px" }}>
                  {importIssues.map((issue, index) => (
                    <li key={`${issue}-${index}`} className="muted">
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div ref={stepOneRef} className="card" style={{ marginBottom: "14px", padding: "14px" }}>
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
            <div className="recipe-new-ingredient-row">
              <div className="recipe-new-ingredient-row__name">
                <ProductAutocompleteInput
                  value={ingredient.name}
                  onChange={(nextValue) => updateIngredient(index, "name", nextValue)}
                  suggestions={productSuggestions}
                  placeholder="Название"
                />
              </div>
              <div className="recipe-new-ingredient-row__meta">
              <input
                type="number"
                value={ingredient.amount}
                onChange={(e) => updateIngredient(index, "amount", parseFloat(e.target.value) || 0)}
                step="0.1"
                min="0"
                placeholder="Кол-во"
                className="input"
                style={{ width: "100%" }}
              />
              <select
                value={ingredient.unit}
                onChange={(e) => updateIngredient(index, "unit", e.target.value)}
                className="input"
                style={{ width: "100%" }}
              >
                {UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
              <button className="btn btn-danger recipe-new-ingredient-row__delete" onClick={() => removeIngredient(index)}>
                Удалить
              </button>
              </div>
            </div>
            {reviewHints[index] ? (
              <p className="muted" style={{ marginTop: "6px", marginBottom: "0" }}>
                Проверьте количество и единицу после импорта.
              </p>
            ) : null}
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
          <button className="btn btn-add" onClick={addIngredient}>
            + Добавить ингредиент
          </button>
        </div>

        <div style={{ marginBottom: "0" }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Способ приготовления</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            className="input"
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
              Это вспомогательные подсказки. Рецепт можно сохранить и без них.
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
                value={shortDescription}
                onChange={(e) => setShortDescription(e.target.value)}
                rows={3}
                className="input"
                style={{ minHeight: "70px", resize: "vertical" }}
              />
            </div>

            <div style={{ marginBottom: "16px", display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <label style={{ display: "block", fontWeight: "bold" }}>
                Порции
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={servings}
                  onChange={(e) => setServings(parseInt(e.target.value, 10) || 0)}
                  className="input"
                  style={{ width: "180px", marginTop: "8px" }}
                />
              </label>

              <label style={{ display: "block", fontWeight: "bold" }}>
                Видимость
                <select
                  className="input"
                  value={visibility}
                  onChange={(e) => handleVisibilityChange(e.target.value as RecipeVisibility)}
                  disabled={!currentUserId}
                  style={{ width: "180px", marginTop: "8px" }}
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
                {!currentUserId ? (
                  <span className="muted" style={{ display: "block", marginTop: "6px", fontWeight: 400 }}>
                    Public доступен после входа.
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

            {visibility === "public" ? (
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
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="input"
                style={{ minHeight: "90px", resize: "vertical" }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: "10px", marginTop: "24px" }}>
        <button
          className="btn btn-primary"
          onClick={saveRecipe}
          disabled={isSaving || (visibility === "public" && !publishConsentChecked)}
        >
          {isSaving ? "Сохранение..." : visibility === "public" ? "Сделать публичным" : "Сохранить рецепт"}
        </button>
        <button className="btn" onClick={() => router.push("/recipes")}>Отмена</button>
      </div>
    </div>
  );
}

