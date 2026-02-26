"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { appendProductSuggestions, loadProductSuggestions } from "../../lib/productSuggestions";
import ProductAutocompleteInput from "../../components/ProductAutocompleteInput";
import { useI18n } from "../../components/I18nProvider";
import { usePlanTier } from "../../lib/usePlanTier";
import { isPaidFeatureEnabled } from "../../lib/subscription";
import { findIngredientIdByName } from "../../lib/ingredientDictionary";
import {
  DEFAULT_UNIT_ID,
  getUnitLabelById,
  getUnitOptions,
  isTasteLikeUnit,
  normalizeUnitId,
  type UnitId,
} from "../../lib/ingredientUnits";
import {
  createRecipe,
  getCurrentUserId,
  replaceRecipeAccessByEmail,
  sendRecipeAccessInvites,
  upsertRecipeTranslation,
  upsertRecipeInLocalCache,
  type Ingredient,
  type RecipeLanguage,
  type RecipeModel,
  type RecipeTranslation,
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

const MAX_IMPORT_PHOTOS = 8;
const IMPORT_MAX_SIDE = 1600;
const IMPORT_QUALITY = 0.84;
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
  if (draft.shortDescription?.trim()) return true;
  if (draft.instructions?.trim()) return true;
  return (draft.ingredients || []).some((item) => item.name?.trim().length > 0);
};

const hasImportedPhotoContent = (draft: ImportedRecipeDraft | null): boolean => {
  if (!draft) return false;
  if (draft.shortDescription?.trim()) return true;
  if (draft.instructions?.trim()) return true;
  return (draft.ingredients || []).some((item) => item.name?.trim().length > 0);
};

const sanitizeImportIssue = (issue: string, photoUnavailableFallback: string): string => {
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
    return photoUnavailableFallback;
  }
  return value;
};

const sanitizeImportIssues = (issues: string[], photoUnavailableFallback: string): string[] =>
  Array.from(new Set(issues.map((issue) => sanitizeImportIssue(issue, photoUnavailableFallback)).filter(Boolean)));

const ACCESS_OPTIONS: Array<{
  value: RecipeVisibility;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    value: "private",
    labelKey: "recipes.new.access.private.label",
    descriptionKey: "recipes.new.access.private.description",
  },
  {
    value: "public",
    labelKey: "recipes.new.access.public.label",
    descriptionKey: "recipes.new.access.public.description",
  },
  {
    value: "link",
    labelKey: "recipes.new.access.link.label",
    descriptionKey: "recipes.new.access.link.description",
  },
  {
    value: "invited",
    labelKey: "recipes.new.access.invited.label",
    descriptionKey: "recipes.new.access.invited.description",
  },
];

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

const normalizeRecipeLanguage = (value: unknown): RecipeLanguage =>
  value === "ru" || value === "en" || value === "es" ? value : "ru";

interface NewRecipeFormProps {
  initialFirstCreate?: boolean;
}

export default function NewRecipeForm({ initialFirstCreate }: NewRecipeFormProps) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { planTier } = usePlanTier();
  const unitOptions = getUnitOptions(locale);
  const canUseRecipeImport = isPaidFeatureEnabled(planTier, "recipe_import");
  const canUseImageGeneration = isPaidFeatureEnabled(planTier, "image_generation");

  const [title, setTitle] = useState("");
  const [shortDescription, setShortDescription] = useState("");
  const [recipeLink, setRecipeLink] = useState("");
  const [instructions, setInstructions] = useState("");
  const [notes, setNotes] = useState("");
  const [image, setImage] = useState("");
  const [servings, setServings] = useState(2);
  const [visibility, setVisibility] = useState<RecipeVisibility>("private");
  const [shareToken, setShareToken] = useState("");
  const [invitedEmailsDraft, setInvitedEmailsDraft] = useState("");
  const [showInvitedAccessEditor, setShowInvitedAccessEditor] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([
    {
      name: "",
      amount: 0,
      unitId: DEFAULT_UNIT_ID,
      unit: getUnitLabelById(DEFAULT_UNIT_ID, locale),
    },
  ]);
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
  const [isPreparingImportPhotos, setIsPreparingImportPhotos] = useState(false);
  const [reviewHints, setReviewHints] = useState<ReviewHintsMap>({});
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const stepOneRef = useRef<HTMLDivElement | null>(null);
  const importRequestIdRef = useRef(0);
  const importPhotosTaskIdRef = useRef(0);
  const hasCoreInput = title.trim().length > 0 || ingredients.some((item) => item.name.trim().length > 0);
  const hasTitle = title.trim().length > 0;
  const canChangeVisibility = Boolean(currentUserId);

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
          const scale = maxSide > IMPORT_MAX_SIDE ? IMPORT_MAX_SIDE / maxSide : 1;
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
          // Always convert imports to JPEG so OCR/vision providers receive a consistent format.
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
    setIngredients((prev) => [
      ...prev,
      {
        name: "",
        amount: 0,
        unitId: DEFAULT_UNIT_ID,
        unit: getUnitLabelById(DEFAULT_UNIT_ID, locale),
      },
    ]);
  };

  const removeIngredient = (index: number) => {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
    setReviewHints({});
  };

  const updateIngredient = (index: number, field: "name" | "amount" | "unit", value: string | number) => {
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
      setAiMessage(t("recipes.new.ai.needIngredient"));
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
      setAiMessage(
        Object.keys(map).length > 0
          ? t("recipes.new.ai.hintsFound")
          : t("recipes.new.ai.hintsNotFound")
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : t("recipes.new.ai.hintsFailed");
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
      setAiMessage(
        data.message || (next.length > 0 ? t("recipes.new.ai.tagsFound") : t("recipes.new.ai.tagsNotFound"))
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : t("recipes.new.ai.tagsFailed");
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
          .map((item) => {
            const unitId = normalizeUnitId(item.unitId || item.unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID);
            return {
              name: item.name.trim(),
              amount: Number(item.amount || 0),
              unit: getUnitLabelById(unitId, locale),
            };
          }),
      });
      setSuggestedServings(data.suggestedServings && data.suggestedServings > 0 ? data.suggestedServings : null);
      setAiMessage(data.message || t("recipes.new.ai.servingsReady"));
    } catch (error) {
      const text = error instanceof Error ? error.message : t("recipes.new.ai.servingsFailed");
      setAiMessage(text);
    } finally {
      setAiAction(null);
    }
  };

  const requestRecipeImage = async () => {
    if (!canUseImageGeneration) {
      setAiMessage(t("subscription.locks.imageGeneration"));
      return;
    }

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
        setAiMessage(data.message || t("recipes.new.ai.imageReady"));
      } else {
        setAiMessage(t("recipes.new.ai.imageMissing"));
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : t("recipes.new.ai.imageFailed");
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
    if (draft.shortDescription?.trim() || draft.image?.trim() || (draft.servings && draft.servings > 0)) {
      setShowAdvancedFields(true);
    }

    const importedIngredients = (draft.ingredients || [])
      .map((item) => {
        const unitId = normalizeUnitId(item.unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID);
        return {
          name: item.name?.trim() || "",
          amount: isTasteLikeUnit(unitId) ? 0 : Math.max(0, Number(item.amount || 0)),
          unitId,
          unit: getUnitLabelById(unitId, locale),
        };
      })
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
    importPhotosTaskIdRef.current += 1;
    setIsPreparingImportPhotos(false);
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
    if (!canUseRecipeImport) {
      const message = t("subscription.locks.recipeImport");
      setImportStatus("error");
      setImportStatusMessage(message);
      setImportIssues([]);
      return;
    }

    const requestId = importRequestIdRef.current + 1;
    importRequestIdRef.current = requestId;
    const normalizedUrl = normalizeImportUrl(importUrl);
    if (!importUrl.trim()) {
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.urlRequired"));
      setImportIssues([]);
      return;
    }
    if (!normalizedUrl) {
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.urlInvalid"));
      setImportIssues([]);
      return;
    }
    if (!isSupportedImportUrl(normalizedUrl)) {
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.urlUnsupported"));
      setImportIssues([]);
      return;
    }

    try {
      setAiAction("import_url");
      setImportStatus("loading");
      setImportStatusMessage(t("recipes.new.import.importing"));
      setImportIssues([]);
      const data = await importRecipeByUrl({
        url: normalizedUrl,
        knownProducts: productSuggestions,
      });
      if (requestId !== importRequestIdRef.current) return;
      applyImportedDraft(data.recipe);
      setImportIssues(
        sanitizeImportIssues(Array.isArray(data.issues) ? data.issues : [], t("recipes.new.import.photoUnavailable"))
      );
      setAiMessage(data.message || "");
      const backendMessage = String(data.message || "").trim();
      if (hasImportedContent(data.recipe)) {
        setImportStatus("success");
        setImportStatusMessage(t("recipes.new.import.urlSuccess"));
        if (backendMessage) setImportStatusMessage(backendMessage);
        scrollToStepOne();
      } else {
        setImportStatus("error");
        setImportStatusMessage(t("recipes.new.import.urlFailed"));
        if (backendMessage) setImportStatusMessage(backendMessage);
      }
    } catch (error) {
      if (requestId !== importRequestIdRef.current) return;
      console.error("[recipes/new] import by URL failed", error);
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.urlFailed"));
    } finally {
      if (requestId === importRequestIdRef.current) {
        setAiAction(null);
      }
    }
  };

  const updateIngredientUnit = (index: number, unitId: UnitId) => {
    setIngredients((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        unitId,
        unit: getUnitLabelById(unitId, locale),
      };
      return updated;
    });
    setReviewHints((prev) => {
      if (!prev[index]) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleImportPhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/")).slice(0, MAX_IMPORT_PHOTOS);
    if (imageFiles.length === 0) {
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.photoRequired"));
      return;
    }

    const taskId = importPhotosTaskIdRef.current + 1;
    importPhotosTaskIdRef.current = taskId;
    setIsPreparingImportPhotos(true);
    setImportStatus("idle");
    setImportStatusMessage(t("recipes.new.import.preparingPhoto"));
    setImportIssues([]);
    Promise.all(imageFiles.map((file) => optimizeImageFile(file))).then((images) => {
      if (taskId !== importPhotosTaskIdRef.current) return;
      setImportPhotoDataUrls(images.filter(Boolean));
      setImportPhotoNames(imageFiles.map((file) => file.name));
      setIsPreparingImportPhotos(false);
      setImportStatus("idle");
      setImportStatusMessage(t("recipes.new.import.photoLoaded", { count: imageFiles.length }));
    }).catch(() => {
      if (taskId !== importPhotosTaskIdRef.current) return;
      setIsPreparingImportPhotos(false);
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.photoPrepareFailed"));
    });
  };

  const handleCameraCaptureChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.cameraReadFailed"));
      return;
    }

    const taskId = importPhotosTaskIdRef.current + 1;
    importPhotosTaskIdRef.current = taskId;
    setIsPreparingImportPhotos(true);
    setImportStatus("idle");
    setImportStatusMessage(t("recipes.new.import.preparingPhoto"));
    setImportIssues([]);
    Promise.all(imageFiles.map((file) => optimizeImageFile(file))).then((images) => {
      if (taskId !== importPhotosTaskIdRef.current) return;
      setImportPhotoDataUrls((prev) => [...prev, ...images].slice(0, MAX_IMPORT_PHOTOS));
      setImportPhotoNames((prev) => [...prev, ...imageFiles.map((file) => file.name)].slice(0, MAX_IMPORT_PHOTOS));
      setIsPreparingImportPhotos(false);
      setImportStatus("idle");
      setImportStatusMessage(t("recipes.new.import.cameraPhotoAdded"));
    }).catch(() => {
      if (taskId !== importPhotosTaskIdRef.current) return;
      setIsPreparingImportPhotos(false);
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.cameraPrepareFailed"));
    });
  };

  const handleImportByPhoto = async () => {
    if (!canUseRecipeImport) {
      const message = t("subscription.locks.recipeImport");
      setImportStatus("error");
      setImportStatusMessage(message);
      setImportIssues([]);
      return;
    }

    const requestId = importRequestIdRef.current + 1;
    importRequestIdRef.current = requestId;
    if (isPreparingImportPhotos) {
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.waitPreparing"));
      setImportIssues([]);
      return;
    }
    if (importPhotoDataUrls.length === 0) {
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.photoAtLeastOne"));
      setImportIssues([]);
      return;
    }

    try {
      setAiAction("import_photo");
      setImportStatus("loading");
      setImportStatusMessage(t("recipes.new.import.recognizing"));
      setImportIssues([]);
      const data = await importRecipeByPhoto({
        imageDataUrls: importPhotoDataUrls,
        knownProducts: productSuggestions,
      });
      if (requestId !== importRequestIdRef.current) return;
      applyImportedDraft(data.recipe);
      setImportIssues(
        sanitizeImportIssues(Array.isArray(data.issues) ? data.issues : [], t("recipes.new.import.photoUnavailable"))
      );
      setAiMessage(data.message || "");
      const backendMessage = String(data.message || "").trim();
      if (hasImportedPhotoContent(data.recipe)) {
        setImportStatus("success");
        setImportStatusMessage(t("recipes.new.import.photoSuccess"));
        if (backendMessage) setImportStatusMessage(backendMessage);
        scrollToStepOne();
      } else {
        setImportStatus("error");
        setImportStatusMessage(t("recipes.new.import.photoRecognizeFailed"));
        if (backendMessage) setImportStatusMessage(backendMessage);
      }
    } catch (error) {
      if (requestId !== importRequestIdRef.current) return;
      console.error("[recipes/new] import by photo failed", error);
      setImportStatus("error");
      setImportStatusMessage(t("recipes.new.import.photoRecognizeFailed"));
    } finally {
      if (requestId === importRequestIdRef.current) {
        setAiAction(null);
      }
    }
  };

  const handleVisibilityChange = (next: RecipeVisibility) => {
    if (!canChangeVisibility && next !== "private") return;
    setVisibility(next);
  };

  const saveRecipe = async () => {
    if (!title.trim()) {
      alert(t("recipes.new.messages.titleRequired"));
      return;
    }

    const normalizedLinkRaw = recipeLink.trim();
    const normalizedLink = normalizedLinkRaw
      ? (/^https?:\/\//i.test(normalizedLinkRaw) ? normalizedLinkRaw : `https://${normalizedLinkRaw}`)
      : "";

    const normalizedTags = Array.from(new Set(selectedTags.map((tag) => tag.trim()).filter(Boolean)));

    const normalizedIngredients = ingredients
      .filter((item) => item.name.trim())
      .map((item) => {
        const unitId = normalizeUnitId(item.unitId || item.unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID);
        return {
          ingredientId: item.ingredientId || findIngredientIdByName(item.name.trim(), locale) || undefined,
          unitId,
          name: item.name.trim(),
          amount: isTasteLikeUnit(unitId) ? 0 : Math.max(0, item.amount || 0),
          unit: getUnitLabelById(unitId, locale),
          note: item.note,
          optional: Boolean(item.optional),
        };
      });

    const baseLanguage = normalizeRecipeLanguage(locale);
    const baseTranslation: RecipeTranslation = {
      language: baseLanguage,
      title: title.trim(),
      shortDescription: shortDescription.trim() || undefined,
      description: normalizedLink || undefined,
      instructions: instructions.trim() || undefined,
      updatedAt: new Date().toISOString(),
      isAutoGenerated: false,
    };
    const translations: Partial<Record<RecipeLanguage, RecipeTranslation>> = {
      [baseLanguage]: baseTranslation,
    };

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
          baseLanguage,
          translations,
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

      const normalizedVisibility: RecipeVisibility = canChangeVisibility ? visibility : "private";
      const normalizedShareToken =
        normalizedVisibility === "link" ? (shareToken.trim() || generateShareToken()) : "";
      const invitedEmails =
        normalizedVisibility === "invited" ? parseInvitedEmails(invitedEmailsDraft) : [];

      const created = await createRecipe(currentUserId, {
        title: title.trim(),
        shortDescription: shortDescription.trim(),
        description: normalizedLink,
        instructions: instructions.trim(),
        notes: notes.trim(),
        image: image.trim(),
        ingredients: normalizedIngredients,
        servings: servings > 0 ? servings : 2,
        visibility: normalizedVisibility,
        shareToken: normalizedShareToken || undefined,
        categories: normalizedTags,
        tags: normalizedTags,
        baseLanguage,
        translations,
      });

      if (normalizedVisibility === "invited") {
        await replaceRecipeAccessByEmail(currentUserId, created.id, invitedEmails);
        if (invitedEmails.length > 0) {
          const inviteResult = await sendRecipeAccessInvites(created.id, invitedEmails);
          if (inviteResult.failed.length > 0) {
            const failedEmails = inviteResult.failed.map((item) => item.email).join(", ");
            alert(t("recipes.new.messages.invitesPartial", { emails: failedEmails }));
          }
        }
      }

      let savedBaseTranslation = baseTranslation;
      try {
        savedBaseTranslation = await upsertRecipeTranslation(currentUserId, created.id, baseTranslation);
      } catch {
        // Translation table can be absent on old schema. Keep recipe creation successful.
      }

      const finalizedRecipe: RecipeModel = {
        ...(normalizedVisibility === "link" && normalizedShareToken
          ? { ...created, shareToken: normalizedShareToken }
          : created),
        baseLanguage,
        translations: {
          ...(created.translations || {}),
          [baseLanguage]: savedBaseTranslation,
        },
      };
      upsertRecipeInLocalCache(finalizedRecipe);
      if (shouldShowFirstRecipeOverlay && typeof window !== "undefined") {
        localStorage.setItem(FIRST_RECIPE_ADDED_KEY, finalizedRecipe.id);
        localStorage.setItem(FIRST_RECIPE_SUCCESS_PENDING_KEY, "1");
        router.push(`/recipes?firstAdded=1&recipe=${encodeURIComponent(finalizedRecipe.id)}`);
      } else {
        router.push(`/recipes/${finalizedRecipe.id}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : t("recipes.new.messages.saveFailed");
      alert(text);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ padding: "20px", maxWidth: "860px", margin: "0 auto" }}>
      <div style={{ marginBottom: "20px" }}>
        <button className="btn" onClick={() => router.push("/recipes")}>
          {t("recipes.new.actions.backToRecipes")}
        </button>
      </div>

      <h1 className="h1" style={{ marginBottom: "20px" }}>
        {t("recipes.new.title")}
      </h1>

      {!currentUserId && (
        <p className="muted" style={{ marginBottom: "14px" }}>
          {t("recipes.new.localDraftMode")}
        </p>
      )}

      {aiMessage && (
        <p className="muted" style={{ marginBottom: "14px" }}>
          {t("recipes.new.ottoPrefix")}: {aiMessage}
        </p>
      )}

      <p className="muted" style={{ marginTop: "-4px", marginBottom: "14px" }}>
        {t("recipes.new.quickStart")}
      </p>

      <div className="card" style={{ marginBottom: "14px", padding: "12px", background: "var(--background-secondary)" }}>
        <button className="btn" type="button" onClick={() => setShowImportTools((prev) => !prev)}>
          {showImportTools ? t("recipes.new.import.hide") : t("recipes.new.import.show")}
        </button>

        {showImportTools ? (
          <div style={{ marginTop: "10px" }}>
            {!canUseRecipeImport ? (
              <p className="muted" style={{ marginTop: 0, marginBottom: "8px" }}>
                {t("subscription.locks.recipeImport")}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
              <button
                className={`btn ${importMode === "url" ? "btn-primary" : ""}`}
                onClick={() => setImportMode("url")}
                type="button"
              >
                {t("recipes.new.import.byUrl")}
              </button>
              <button
                className={`btn ${importMode === "photo" ? "btn-primary" : ""}`}
                onClick={() => setImportMode("photo")}
                type="button"
              >
                {t("recipes.new.import.byPhoto")}
              </button>
            </div>

            {importMode === "url" ? (
              <div style={{ display: "grid", gap: "8px" }}>
                <input
                  className="input"
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder={t("recipes.new.import.urlPlaceholder")}
                />
                <button className="btn btn-primary" onClick={handleImportByUrl} disabled={aiAction === "import_url"}>
                  {aiAction === "import_url" ? t("recipes.new.import.importing") : t("recipes.new.import.importAction")}
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
                    {t("recipes.new.import.takePhoto")}
                  </button>
                  {importPhotoDataUrls.length > 0 ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={clearImportPhotos}
                    >
                      {t("recipes.new.import.clearPhoto")}
                    </button>
                  ) : null}
                </div>
                {importPhotoDataUrls.length > 0 ? (
                  <div style={{ display: "grid", gap: "6px" }}>
                    <p className="muted" style={{ margin: 0 }}>
                      {t("recipes.new.import.photosCount", { count: importPhotoDataUrls.length })}
                    </p>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {importPhotoNames.map((name, index) => (
                        <button
                          key={`${name}-${index}`}
                          type="button"
                          className="btn"
                          onClick={() => removeImportPhotoAt(index)}
                          style={{ padding: "4px 8px", fontSize: "12px" }}
                          title={t("recipes.new.import.removePhoto")}
                        >
                          {name || t("recipes.new.import.photoN", { index: index + 1 })} ×
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <button
                  className="btn btn-primary"
                  onClick={handleImportByPhoto}
                  disabled={aiAction === "import_photo" || isPreparingImportPhotos}
                >
                  {isPreparingImportPhotos
                    ? t("recipes.new.import.preparingPhoto")
                    : aiAction === "import_photo"
                      ? t("recipes.new.import.recognizing")
                      : t("recipes.new.import.recognizeAction")}
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
                <p className="muted" style={{ marginBottom: "6px" }}>{t("recipes.new.import.reviewAfterImport")}</p>
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
        <h3 style={{ margin: "0 0 10px 0" }}>{t("recipes.new.step1.title")}</h3>
        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold", fontSize: "18px" }}>
            {t("recipes.new.fields.title")}
          </label>
          <input className="input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
            {t("recipes.new.fields.access")}
          </label>
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
                  <span>{t(option.labelKey)}</span>
                  <span style={{ fontSize: "12px", opacity: 0.85 }}>{t(option.descriptionKey)}</span>
                </button>
              );
            })}
          </div>
          {!canChangeVisibility ? (
            <p className="muted" style={{ margin: "8px 0 0 0" }}>
              {t("recipes.new.access.loginRequired")}
            </p>
          ) : null}

          {visibility === "link" ? (
            <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
              <p className="muted" style={{ margin: 0 }}>
                {t("recipes.new.access.linkAvailableAfterSave")}
              </p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShareToken(generateShareToken())}
                >
                  {t("recipes.new.access.generateLink")}
                </button>
                {shareToken ? (
                  <span className="muted" style={{ alignSelf: "center", fontSize: "12px" }}>
                    {t("recipes.new.access.token")}: {shareToken.slice(0, 12)}...
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {visibility === "invited" ? (
            <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setShowInvitedAccessEditor((prev) => !prev)}
              >
                {t("recipes.new.access.manage")}
              </button>
              {showInvitedAccessEditor ? (
                <div style={{ display: "grid", gap: "6px" }}>
                  <textarea
                    className="input"
                    rows={4}
                    value={invitedEmailsDraft}
                    onChange={(e) => setInvitedEmailsDraft(e.target.value)}
                    placeholder={t("recipes.new.access.invitedPlaceholder")}
                    style={{ minHeight: "88px", resize: "vertical" }}
                  />
                  <p className="muted" style={{ margin: 0 }}>
                    {t("recipes.new.access.invitedHelp")}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div style={{ marginBottom: "16px" }}>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px", flexWrap: "wrap" }}>
            <label style={{ display: "block", fontWeight: "bold" }}>{t("recipes.new.fields.ingredients")}</label>
          </div>
        {ingredients.map((ingredient, index) => (
          <div key={index} style={{ marginBottom: "10px" }}>
            <div className="recipe-new-ingredient-row">
              <div className="recipe-new-ingredient-row__name">
                <ProductAutocompleteInput
                  value={ingredient.name}
                  onChange={(nextValue) => updateIngredient(index, "name", nextValue)}
                  suggestions={productSuggestions}
                  placeholder={t("recipes.new.fields.ingredientNamePlaceholder")}
                />
              </div>
              <div className="recipe-new-ingredient-row__meta">
              <input
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
                placeholder={t("recipes.new.fields.ingredientAmountPlaceholder")}
                className="input"
                style={{ width: "100%" }}
              />
              <select
                value={normalizeUnitId(ingredient.unitId || ingredient.unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID)}
                onChange={(e) => updateIngredientUnit(index, e.target.value as UnitId)}
                className="input"
                style={{ width: "100%" }}
              >
                {unitOptions.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.label}
                  </option>
                ))}
              </select>
              <button className="btn btn-danger recipe-new-ingredient-row__delete" onClick={() => removeIngredient(index)}>
                {t("recipes.new.actions.deleteIngredient")}
              </button>
              </div>
            </div>
            {reviewHints[index] ? (
              <p className="muted" style={{ marginTop: "6px", marginBottom: "0" }}>
                {t("recipes.new.messages.checkAmountAndUnit")}
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
            {t("recipes.new.actions.addIngredient")}
          </button>
        </div>

        <div style={{ marginBottom: "0" }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
            {t("recipes.new.fields.instructions")}
          </label>
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
          {showAiTools ? t("recipes.new.ai.hideTools") : t("recipes.new.ai.showTools")}
        </button>
        {showAiTools ? (
          <div style={{ marginTop: "10px" }}>
            <p className="muted" style={{ marginTop: 0, marginBottom: "8px" }}>
              {t("recipes.new.ai.toolsHint")}
            </p>
            {!canUseImageGeneration ? (
              <p className="muted" style={{ marginTop: 0, marginBottom: "8px" }}>
                {t("subscription.locks.imageGeneration")}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button className="btn" onClick={requestIngredientHints} disabled={aiAction === "ingredients" || !hasCoreInput}>
                {aiAction === "ingredients" ? t("recipes.new.ai.searching") : t("recipes.new.ai.suggestNames")}
              </button>
              <button className="btn" onClick={requestServingsHint} disabled={aiAction === "servings" || !hasCoreInput}>
                {aiAction === "servings" ? t("recipes.new.ai.counting") : t("recipes.new.ai.suggestServings")}
              </button>
              <button className="btn" onClick={requestTagHints} disabled={aiAction === "tags" || !hasCoreInput}>
                {aiAction === "tags" ? t("recipes.new.ai.thinking") : t("recipes.new.ai.suggestTags")}
              </button>
              <button className="btn" onClick={requestRecipeImage} disabled={aiAction === "image" || !hasCoreInput}>
                {aiAction === "image" ? t("recipes.new.ai.generating") : t("recipes.new.ai.generatePhoto")}
              </button>
              {suggestedServings ? (
                <button className="btn btn-primary" onClick={() => setServings(suggestedServings)}>
                  {t("recipes.new.ai.applyServings", { count: suggestedServings })}
                </button>
              ) : null}
              {suggestedTags.length > 0 ? (
                <button
                  className="btn btn-primary"
                  onClick={() => setSelectedTags((prev) => Array.from(new Set([...prev, ...suggestedTags])))}
                >
                  {t("recipes.new.ai.addSuggestedTags")}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginBottom: "20px", padding: "12px", background: "var(--background-secondary)" }}>
        <button className="btn" type="button" onClick={() => setShowAdvancedFields((prev) => !prev)}>
          {showAdvancedFields ? t("recipes.new.step2.hide") : t("recipes.new.step2.show")}
        </button>

        {showAdvancedFields ? (
          <div style={{ marginTop: "12px" }}>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
                {t("recipes.new.fields.shortDescription")}
              </label>
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
                {t("recipes.new.fields.servings")}
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
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
                {t("recipes.new.fields.source")}
              </label>
              <input
                className="input"
                type="url"
                value={recipeLink}
                onChange={(e) => setRecipeLink(e.target.value)}
                placeholder="https://..."
              />
              <p className="muted" style={{ marginTop: "8px" }}>
                {t("recipes.new.fields.sourceHint")}
              </p>
              {visibility !== "private" ? (
                <p className="muted" style={{ marginTop: "8px" }}>
                  {t("recipes.new.fields.sourceWarning")}
                </p>
              ) : null}
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontWeight: "bold", marginBottom: "8px" }}>
                {t("recipes.new.fields.tags")}
              </label>
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
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
                {t("recipes.new.fields.image")}
              </label>
              {image ? (
                <div>
                  <img
                    src={image}
                    alt={t("recipes.new.fields.imagePreviewAlt")}
                    style={{ maxWidth: "220px", maxHeight: "220px", borderRadius: "10px", display: "block", marginBottom: "10px" }}
                  />
                  <button className="btn btn-danger" onClick={() => setImage("")}>
                    {t("recipes.new.actions.deleteImage")}
                  </button>
                </div>
              ) : (
                <input type="file" accept="image/*" onChange={handleImageUpload} className="input" />
              )}
            </div>

            <div style={{ marginBottom: "0" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
                {t("recipes.new.fields.notes")}
              </label>
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
          disabled={isSaving || !hasTitle}
        >
          {isSaving ? t("recipes.new.actions.saving") : t("recipes.new.actions.saveRecipe")}
        </button>
        <button className="btn" onClick={() => router.push("/recipes")}>{t("recipes.new.actions.cancel")}</button>
      </div>
    </div>
  );
}

