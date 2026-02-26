"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import LinkifiedText from "../../components/LinkifiedText";
import ProductAutocompleteInput from "../../components/ProductAutocompleteInput";
import { appendProductSuggestions, loadProductSuggestions } from "../../lib/productSuggestions";
import { usePlanTier } from "../../lib/usePlanTier";
import { isPaidFeatureEnabled } from "../../lib/subscription";
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
  type RecipeReportReasonId,
  type RecipeLanguage,
  type RecipeModel,
  type RecipeTranslation,
  type RecipeVisibility,
  upsertRecipeTranslation,
  updateRecipe,
  upsertRecipeInLocalCache,
} from "../../lib/recipesSupabase";
import { useI18n } from "../../components/I18nProvider";
import { findIngredientIdByName, getIngredientNameById } from "../../lib/ingredientDictionary";
import {
  DEFAULT_UNIT_ID,
  getUnitLabel,
  getUnitLabelById,
  getUnitOptions,
  isTasteLikeUnit,
  normalizeUnitId,
  type UnitId,
} from "../../lib/ingredientUnits";
import { isSupabaseConfigured } from "../../lib/supabaseClient";
import { RECIPE_TAGS, localizeRecipeTag, normalizeRecipeTags } from "../../lib/recipeTags";
import {
  getIngredientHints,
  getRecipeTranslationDraft,
  getRecipeImage,
  getServingsHint,
  getTagHints,
} from "../../lib/aiAssistantClient";
import { downloadPdfExport } from "../../lib/pdfExportClient";
import { resolveRecipeImageForCard } from "../../lib/recipeImageCatalog";

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

const normalizeRecipeTitle = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
const normalizeRecipeLanguage = (value: unknown): RecipeLanguage =>
  value === "ru" || value === "en" || value === "es" ? value : "ru";
const resolveRecipeLanguageFromLocale = (value: string): RecipeLanguage => {
  const normalized = String(value || "").toLowerCase();
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("en")) return "en";
  return "ru";
};
const getPreferredContentLanguage = (source: RecipeModel, locale: string): RecipeLanguage => {
  const fromUi = resolveRecipeLanguageFromLocale(locale);
  const base = normalizeRecipeLanguage(source.baseLanguage);
  if (fromUi === base) return base;
  if (source.translations?.[fromUi]) return fromUi;
  return base;
};

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

const VISIBILITY_LABEL_KEYS: Record<RecipeVisibility, string> = {
  private: "recipes.new.access.private.label",
  public: "recipes.new.access.public.label",
  link: "recipes.new.access.link.label",
  invited: "recipes.new.access.invited.label",
};

const generateShareToken = (): string => crypto.randomUUID().replace(/-/g, "");

const REPORT_REASON_OPTIONS: Array<{ value: RecipeReportReasonId; labelKey: string }> = [
  {
    value: "copyright",
    labelKey: "recipes.detail.report.reasons.copyright",
  },
  {
    value: "foreign_without_source",
    labelKey: "recipes.detail.report.reasons.foreignWithoutSource",
  },
  {
    value: "other",
    labelKey: "recipes.detail.report.reasons.other",
  },
];

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
  return (
    resolveRecipeImageForCard({
      id: recipe.id,
      title: recipe.title,
      image: recipe.image,
      type: recipe.type,
      isTemplate: recipe.isTemplate,
    }) || ""
  );
};

export default function RecipeDetailPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const { planTier } = usePlanTier();
  const unitOptions = getUnitOptions(locale);
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
  const [reportReason, setReportReason] = useState<RecipeReportReasonId>(REPORT_REASON_OPTIONS[0].value);
  const [reportDetails, setReportDetails] = useState("");
  const [isReportedHidden, setIsReportedHidden] = useState(false);
  const [contentLanguage, setContentLanguage] = useState<RecipeLanguage>("ru");
  const [translationNotice, setTranslationNotice] = useState("");
  const [isCreatingTranslation, setIsCreatingTranslation] = useState(false);
  const [isExportingRecipePdf, setIsExportingRecipePdf] = useState(false);
  const hasCoreInput = title.trim().length > 0 || ingredients.some((item) => item.name.trim().length > 0);
  const canUseAiTranslation = isPaidFeatureEnabled(planTier, "ai_translation");
  const canUseImageGeneration = isPaidFeatureEnabled(planTier, "image_generation");
  const canUsePdfExport = isPaidFeatureEnabled(planTier, "pdf_export");

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
    setSelectedTags(normalizeRecipeTags(source.tags || source.categories || []));
    setTranslationNotice("");
  };

  const loadRecipe = async () => {
    setIsLoading(true);
    setProductSuggestions(loadProductSuggestions());

    try {
      const localRecipe = loadLocalRecipes().find((item) => item.id === recipeId) || null;
      if (!isSupabaseConfigured()) {
        setRecipe(localRecipe);
        if (localRecipe) {
          const preferred = getPreferredContentLanguage(localRecipe, locale);
          setContentLanguage(preferred);
          resetFormFromRecipe(localRecipe, preferred);
        }
        return;
      }

      if (localRecipe) {
        setRecipe(localRecipe);
        const preferred = getPreferredContentLanguage(localRecipe, locale);
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
        const preferred = getPreferredContentLanguage(data, locale);
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
        const preferred = getPreferredContentLanguage(localFallback, locale);
        setContentLanguage(preferred);
        resetFormFromRecipe(localFallback, preferred);
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
  };

  const updateIngredient = (index: number, field: "name" | "amount" | "unit", value: string | number) => {
    setIngredients((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
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
      const next = normalizeRecipeTags(data.suggestedTags || []).filter((tag) => allowed.has(tag));
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
        setImage(data.imageUrl);
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

  const saveCurrentRecipe = async () => {
    if (!title.trim()) {
      alert(t("recipes.new.messages.titleRequired"));
      return;
    }

    if (!recipe) return;

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
    const normalizedTags = normalizeRecipeTags(selectedTags);
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
        alert(t("recipes.detail.messages.editOwnerOnly"));
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
            setAccessNotice(t("recipes.detail.messages.invitesPartial", { emails: failedEmails }));
          } else {
            setAccessNotice(t("recipes.detail.messages.invitesSentCount", { count: inviteResult.sent.length }));
          }
        } else {
          setAccessNotice(t("recipes.detail.messages.invitesUpdated"));
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
      const text = error instanceof Error ? error.message : t("recipes.new.messages.saveFailed");
      alert(text);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteCurrentRecipe = async () => {
    if (!recipe) return;
    const localizedTitle =
      getRecipeTranslation(recipe, contentLanguage)?.title || recipe.title || t("menu.fallback.recipeTitle");
    if (!confirm(t("recipes.messages.deleteOneConfirm", { title: localizedTitle }))) return;

    try {
      if (!isSupabaseConfigured() || !recipe.ownerId) {
        removeRecipeFromLocalCache(recipe.id);
        router.push("/recipes");
        return;
      }

      if (!currentUserId || !canEdit) {
        alert(t("recipes.detail.messages.deleteOwnerOnly"));
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
      const text = error instanceof Error ? error.message : t("recipes.messages.deleteFailed");
      alert(text);
    }
  };

  const createTranslationDraft = async (
    targetLanguage: RecipeLanguage = contentLanguage,
    options?: { previewOnly?: boolean; replaceExisting?: boolean }
  ) => {
    if (!recipe) return;
    const previewOnly = Boolean(options?.previewOnly);
    const replaceExisting = Boolean(options?.replaceExisting);
    if (!previewOnly && !canEdit) return;
    if (recipe.translations?.[targetLanguage] && !replaceExisting) {
      setTranslationNotice(t("recipes.detail.translation.exists"));
      return;
    }

    const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
    const base = getRecipeTranslation(recipe, baseLanguage);
    const fallbackDraft: RecipeTranslation = {
      language: targetLanguage,
      title: (base?.title || recipe.title || "").trim(),
      shortDescription: (base?.shortDescription || recipe.shortDescription || "").trim() || undefined,
      description: (base?.description || recipe.description || "").trim() || undefined,
      instructions: (base?.instructions || recipe.instructions || "").trim() || undefined,
      updatedAt: new Date().toISOString(),
      isAutoGenerated: canUseAiTranslation,
    };

    if (!fallbackDraft.title) {
      setTranslationNotice(t("recipes.detail.translation.noTitle"));
      return;
    }

    try {
      setIsCreatingTranslation(true);
      let draft = fallbackDraft;
      let notice = canUseAiTranslation
        ? t("recipes.detail.translation.draftCreated")
        : t("recipes.detail.translation.manualDraftCreated");

      if (canUseAiTranslation) {
        try {
          const aiDraft = await getRecipeTranslationDraft({
            sourceLanguage: baseLanguage,
            targetLanguage,
            title: fallbackDraft.title,
            shortDescription: fallbackDraft.shortDescription,
            description: fallbackDraft.description,
            instructions: fallbackDraft.instructions,
          });

          const translated = aiDraft.translation;
          const aiMessage = String(aiDraft.message || "").toLowerCase();
          const isAiUnavailable =
            aiMessage.includes("temporarily unavailable") ||
            aiMessage.includes("created draft from source text");

          draft = {
            ...fallbackDraft,
            title: (translated.title || fallbackDraft.title || "").trim(),
            shortDescription:
              (translated.shortDescription || fallbackDraft.shortDescription || "").trim() || undefined,
            description: (translated.description || fallbackDraft.description || "").trim() || undefined,
            instructions: (translated.instructions || fallbackDraft.instructions || "").trim() || undefined,
            updatedAt: new Date().toISOString(),
            isAutoGenerated: !isAiUnavailable,
          };
          notice = isAiUnavailable
            ? t("recipes.detail.translation.aiUnavailable")
            : t("recipes.detail.translation.createdReview");
        } catch {
          notice = t("recipes.detail.translation.aiUnavailable");
        }
      }

      const nextTranslations = { ...(recipe.translations || {}), [targetLanguage]: draft };

      if (previewOnly) {
        const previewRecipe: RecipeModel = {
          ...recipe,
          translations: nextTranslations,
        };
        setRecipe(previewRecipe);
        setContentLanguage(targetLanguage);
        resetFormFromRecipe(previewRecipe, targetLanguage);
        setTranslationNotice(`${notice} ${t("recipes.detail.translation.previewNotSaved")}`);
        return;
      }

      if (!isSupabaseConfigured() || !recipe.ownerId || !currentUserId) {
        const localUpdated: RecipeModel = {
          ...recipe,
          translations: nextTranslations,
        };
        upsertRecipeInLocalCache(localUpdated);
        setRecipe(localUpdated);
        setContentLanguage(targetLanguage);
        resetFormFromRecipe(localUpdated, targetLanguage);
        setTranslationNotice(notice);
        return;
      }

      const saved = await upsertRecipeTranslation(currentUserId, recipe.id, draft);
      const updatedRecipe: RecipeModel = {
        ...recipe,
        translations: { ...(recipe.translations || {}), [targetLanguage]: saved },
      };
      upsertRecipeInLocalCache(updatedRecipe);
      setRecipe(updatedRecipe);
      setContentLanguage(targetLanguage);
      resetFormFromRecipe(updatedRecipe, targetLanguage);
      setTranslationNotice(notice);
    } catch (error) {
      const text = toErrorText(error, t("recipes.detail.translation.createFailed"));
      setTranslationNotice(text);
    } finally {
      setIsCreatingTranslation(false);
    }
  };

  const switchContentLanguage = async (nextLanguage: RecipeLanguage) => {
    setContentLanguage(nextLanguage);
    if (!recipe) return;

    resetFormFromRecipe(recipe, nextLanguage);

    const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
    const hasTranslation = nextLanguage === baseLanguage || Boolean(recipe.translations?.[nextLanguage]);
    if (hasTranslation) {
      setTranslationNotice("");
      return;
    }

    if (!canEdit) {
      if (canUseAiTranslation) {
        await createTranslationDraft(nextLanguage, { previewOnly: true });
        return;
      }
      setTranslationNotice(t("recipes.detail.translation.versionMissing"));
      return;
    }

    await createTranslationDraft(nextLanguage);
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
      const text = toErrorText(error, t("recipes.messages.copyFailed"));
      alert(text);
    }
  };

  const copyShareLink = async () => {
    if (!recipe) return;
    const token = (shareToken || recipe.shareToken || "").trim();
    if (!token) {
      setShareCopyMessage(t("recipes.detail.share.generateAndSave"));
      return;
    }

    if (typeof window === "undefined") return;
    const shareUrl = `${window.location.origin}/recipes/${encodeURIComponent(recipe.id)}?share=${encodeURIComponent(token)}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopyMessage(t("recipes.detail.share.copied"));
      window.setTimeout(() => setShareCopyMessage(""), 1200);
    } catch {
      setShareCopyMessage(t("recipes.detail.share.copyFailed"));
    }
  };

  const exportRecipePdf = async () => {
    if (!recipe) return;
    if (!canUsePdfExport) {
      setTranslationNotice(t("subscription.availableInPro"));
      return;
    }

    const active = getRecipeTranslation(recipe, contentLanguage);
    const exportTitle = (active?.title || recipe.title || "").trim();
    const exportDescription = active?.description || recipe.description || "";
    const exportInstructions =
      active?.instructions ||
      recipe.instructions ||
      (looksLikeLink(exportDescription) ? "" : exportDescription);

    const stepLines = exportInstructions
      .split(/\n+/g)
      .map((line) => line.trim())
      .filter(Boolean);

    const ingredientLines = (recipe.ingredients || []).map((item) => {
      const detectedIngredientId =
        item.ingredientId ||
        findIngredientIdByName(item.name, "ru") ||
        findIngredientIdByName(item.name, "en") ||
        findIngredientIdByName(item.name, "es") ||
        "";
      const localizedName = getIngredientNameById(detectedIngredientId, locale, item.name);
      const localizedUnit = getUnitLabel(item.unitId || item.unit, locale, item.unit);
      return isTasteLikeUnit(item.unitId || item.unit)
        ? `${localizedName} — ${t("recipes.detail.taste")}`
        : `${item.amount} ${localizedUnit} ${localizedName}`;
    });

    const cookingTimeValue = [...(recipe.tags || []), ...(recipe.categories || [])].find((value) =>
      /\d+\s*(мин|min|ч|hour|hr)/i.test(value || "")
    );

    try {
      setIsExportingRecipePdf(true);
      await downloadPdfExport({
        kind: "recipe",
        fileName: `${exportTitle || "recipe"}.pdf`,
        recipe: {
          title: exportTitle || t("menu.fallback.recipeTitle"),
          servings: recipe.servings || 2,
          cookingTime: cookingTimeValue || undefined,
          ingredients: ingredientLines,
          steps: stepLines.length > 0 ? stepLines : [t("pdf.fallback.noSteps")],
        },
      });
    } catch (error) {
      const text = toErrorText(error, t("pdf.errors.exportFailed"));
      setTranslationNotice(text);
    } finally {
      setIsExportingRecipePdf(false);
    }
  };

  const submitReport = () => {
    if (!recipe) return;
    reportRecipeForReview(
      recipe.id,
      reportReason,
      reportDetails
    );
    setShowReportForm(false);
    setIsReportedHidden(true);
  };

  if (isLoading) {
    return <div style={{ padding: "20px", textAlign: "center" }}>{t("recipes.loading")}</div>;
  }

  if (isReportedHidden) {
    return (
      <div style={{ padding: "20px", maxWidth: "760px", margin: "0 auto" }}>
        <div className="card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>{t("recipes.detail.hidden.title")}</h2>
          <p style={{ marginBottom: "12px" }}>
            {t("recipes.detail.hidden.description")}
          </p>
          <button className="btn" onClick={() => router.push("/recipes")}>
            {t("recipes.detail.actions.toRecipes")}
          </button>
        </div>
      </div>
    );
  }

  if (!recipe) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <p>{t("recipes.detail.notFound")}</p>
        <button className="btn" onClick={() => router.push("/recipes")}>{t("recipes.detail.actions.toRecipes")}</button>
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
  const isMissingTranslation = !recipe.translations?.[contentLanguage] && contentLanguage !== baseLanguage;
  const canCreateTranslation = canEdit && isMissingTranslation;
  const canPreviewTranslation = !canEdit && canUseAiTranslation && isMissingTranslation;
  const canRegenerateTranslation =
    canEdit &&
    canUseAiTranslation &&
    contentLanguage !== baseLanguage &&
    Boolean(recipe.translations?.[contentLanguage]);

  return (
    <div style={{ padding: "20px", maxWidth: "900px", margin: "0 auto" }}>
      <div style={{ marginBottom: "20px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button className="btn" onClick={() => router.push("/recipes")}>{t("recipes.detail.actions.backToRecipes")}</button>

        {!isEditing && canEdit && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setIsEditing(true);
              setShowAiTools(false);
              setShowAdvancedFields(false);
            }}
          >
            {t("recipes.detail.actions.edit")}
          </button>
        )}

        {isEditing && (
          <>
            <button
              className="btn btn-primary"
              onClick={saveCurrentRecipe}
              disabled={isSaving}
            >
              {isSaving ? t("recipes.new.actions.saving") : t("recipes.new.actions.saveRecipe")}
            </button>
            <button
              className="btn"
              onClick={() => {
                resetFormFromRecipe(recipe);
                setIsEditing(false);
              }}
            >
              {t("recipes.new.actions.cancel")}
            </button>
          </>
        )}

        {canEdit && (
          <button className="btn btn-danger" onClick={deleteCurrentRecipe}>
            {t("recipes.detail.actions.delete")}
          </button>
        )}

        <button
          className="btn"
          onClick={() => {
            void exportRecipePdf();
          }}
          disabled={isExportingRecipePdf || !canUsePdfExport}
          title={!canUsePdfExport ? t("subscription.availableInPro") : undefined}
        >
          {isExportingRecipePdf ? t("pdf.actions.exporting") : t("pdf.actions.exportRecipe")}
        </button>

        {showCopyButton && (
          <button className="btn btn-primary" onClick={copyToMine}>{t("recipes.card.addToMine")}</button>
        )}

        {showReportButton && !isEditing && (
          <button
            type="button"
            className="recipes-report-link"
            onClick={() => setShowReportForm((prev) => !prev)}
          >
            {t("recipes.detail.actions.report")}
          </button>
        )}
      </div>

      <div className="card" style={{ marginBottom: "14px", padding: "10px 12px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted" style={{ marginRight: "4px" }}>{t("recipes.detail.translation.languageLabel")}</span>
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
                title={
                  exists
                    ? t("recipes.detail.translation.versionAvailable")
                    : t("recipes.detail.translation.versionMissing")
                }
              >
                {LANGUAGE_LABELS[language]}{exists ? "" : " *"}
              </button>
            );
          })}

          {canCreateTranslation || canPreviewTranslation ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void createTranslationDraft(contentLanguage, { previewOnly: canPreviewTranslation });
              }}
              disabled={isCreatingTranslation}
            >
              {isCreatingTranslation
                ? t("recipes.detail.translation.creating")
                : canUseAiTranslation
                  ? t("recipes.detail.translation.createButton", { lang: LANGUAGE_LABELS[contentLanguage] })
                  : t("recipes.detail.translation.createManualButton", { lang: LANGUAGE_LABELS[contentLanguage] })}
            </button>
          ) : null}
          {canRegenerateTranslation ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void createTranslationDraft(contentLanguage, { replaceExisting: true });
              }}
              disabled={isCreatingTranslation}
            >
              {isCreatingTranslation
                ? t("recipes.detail.translation.creating")
                : t("recipes.detail.translation.regenerateButton", { lang: LANGUAGE_LABELS[contentLanguage] })}
            </button>
          ) : null}
        </div>
        {canCreateTranslation && !canUseAiTranslation ? (
          <p className="muted" style={{ margin: "8px 0 0 0" }}>
            {t("subscription.locks.translationAi")}
          </p>
        ) : null}
        {translationNotice ? (
          <p className="muted" style={{ margin: "8px 0 0 0" }}>{translationNotice}</p>
        ) : null}
      </div>
      {!canUsePdfExport ? (
        <p className="muted" style={{ marginTop: "-6px", marginBottom: "12px" }}>
          {t("subscription.availableInPro")}
        </p>
      ) : null}

      {showReportButton && showReportForm && !isEditing && (
        <div className="card" style={{ marginBottom: "16px", padding: "14px" }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
            {t("recipes.detail.report.reason")}
          </label>
          <select
            className="input"
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value as RecipeReportReasonId)}
            style={{ maxWidth: "360px", marginBottom: "10px" }}
          >
            {REPORT_REASON_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          <textarea
            className="input"
            rows={3}
            value={reportDetails}
            onChange={(e) => setReportDetails(e.target.value)}
            placeholder={t("recipes.detail.report.commentPlaceholder")}
            style={{ minHeight: "80px" }}
          />
          <p className="muted" style={{ marginTop: "8px" }}>
            {t("recipes.detail.hidden.description")}
          </p>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <button className="btn btn-primary" onClick={submitReport}>
              {t("recipes.detail.report.submit")}
            </button>
            <button className="btn" onClick={() => setShowReportForm(false)}>
              {t("recipes.new.actions.cancel")}
            </button>
          </div>
        </div>
      )}

      {isEditing ? (
        <div>
          {aiMessage && (
            <p className="muted" style={{ marginBottom: "14px" }}>
              {t("recipes.new.ottoPrefix")}: {aiMessage}
            </p>
          )}

          <p className="muted" style={{ marginTop: "-4px", marginBottom: "14px" }}>
            {t("recipes.new.quickStart")}
          </p>

          <div className="card" style={{ marginBottom: "14px", padding: "14px" }}>
            <h3 style={{ margin: "0 0 10px 0" }}>{t("recipes.new.step1.title")}</h3>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold", fontSize: "18px" }}>{t("recipes.new.fields.title")}</label>
              <input className="input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>{t("recipes.new.fields.access")}</label>
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
                  {t("recipes.detail.access.ownerOnly")}
                </p>
              ) : null}

              {visibility === "link" ? (
                <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button type="button" className="btn" onClick={() => setShareToken(generateShareToken())}>
                      {t("recipes.new.access.generateLink")}
                    </button>
                    <button type="button" className="btn" onClick={copyShareLink}>
                      {t("recipes.detail.share.copyLink")}
                    </button>
                  </div>
                  {shareCopyMessage ? (
                    <p className="muted" style={{ margin: 0 }}>
                      {shareCopyMessage}
                    </p>
                  ) : null}
                  {shareToken || recipe.shareToken ? (
                    <p className="muted" style={{ margin: 0 }}>
                      {t("recipes.new.access.token")}: {(shareToken || recipe.shareToken || "").slice(0, 12)}...
                    </p>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>
                      {t("recipes.new.access.linkAvailableAfterSave")}
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

              {accessNotice ? (
                <p className="muted" style={{ margin: "8px 0 0 0" }}>
                  {accessNotice}
                </p>
              ) : null}
            </div>

            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px", flexWrap: "wrap" }}>
                <label style={{ display: "block", fontWeight: "bold" }}>{t("recipes.new.fields.ingredients")}</label>
              </div>
            {ingredients.map((ingredient, index) => (
              <div key={index} style={{ marginBottom: "10px" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <ProductAutocompleteInput
                      value={ingredient.name}
                      onChange={(nextValue) => updateIngredient(index, "name", nextValue)}
                      suggestions={productSuggestions}
                      placeholder={t("recipes.new.fields.ingredientNamePlaceholder")}
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
                    placeholder={t("recipes.new.fields.ingredientAmountPlaceholder")}
                    style={{ width: "110px" }}
                  />
                  <select
                    className="input"
                    value={normalizeUnitId(ingredient.unitId || ingredient.unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID)}
                    onChange={(e) => updateIngredientUnit(index, e.target.value as UnitId)}
                    style={{ width: "120px" }}
                  >
                    {unitOptions.map((unit) => (
                      <option key={unit.id} value={unit.id}>{unit.label}</option>
                    ))}
                  </select>
                  <button className="btn btn-danger" onClick={() => removeIngredient(index)}>{t("recipes.new.actions.deleteIngredient")}</button>
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
              <button className="btn btn-add" onClick={addIngredient}>{t("recipes.new.actions.addIngredient")}</button>
            </div>

            <div style={{ marginBottom: "0" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>{t("recipes.new.fields.instructions")}</label>
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
                  <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>{t("recipes.new.fields.shortDescription")}</label>
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
                    {t("recipes.new.fields.servings")}
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
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: "8px" }}>{t("recipes.new.fields.tags")}</label>
                  {suggestedTags.length > 0 ? (
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                      {suggestedTags.map((tag) => (
                        <button
                          key={`hint-${tag}`}
                          className="btn"
                          onClick={() => setSelectedTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]))}
                        >
                          + {localizeRecipeTag(tag, locale as "ru" | "en" | "es")}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {RECIPE_TAGS.map((tag) => {
                      const checked = selectedTags.includes(tag);
                      const tagLabel = localizeRecipeTag(tag, locale as "ru" | "en" | "es");
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
                          <span style={{ fontSize: "13px" }}>{tagLabel}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>{t("recipes.new.fields.image")}</label>
                  {image ? (
                    <div>
                      <img
                        src={image}
                        alt={t("recipes.new.fields.imagePreviewAlt")}
                        style={{ maxWidth: "220px", maxHeight: "220px", borderRadius: "10px", display: "block", marginBottom: "10px" }}
                      />
                      <button className="btn btn-danger" onClick={() => setImage("")}>{t("recipes.new.actions.deleteImage")}</button>
                    </div>
                  ) : (
                    <input type="file" accept="image/*" onChange={handleImageUpload} className="input" />
                  )}
                </div>

                <div style={{ marginBottom: "0" }}>
                  <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>{t("recipes.new.fields.notes")}</label>
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
                alt={displayTitle || recipe.title || t("menu.fallback.recipeTitle")}
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
            <strong>{t("recipes.new.fields.servings")}:</strong> {recipe.servings || 2}
          </p>

          <p style={{ marginBottom: "16px" }}>
            <strong>{t("recipes.detail.visibilityLabel")}:</strong> {t(VISIBILITY_LABEL_KEYS[recipe.visibility || "private"])}
          </p>

          {recipe.tags && recipe.tags.length > 0 && (
            <div style={{ marginBottom: "16px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {normalizeRecipeTags(recipe.tags).map((tag) => (
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
                  {localizeRecipeTag(tag, locale as "ru" | "en" | "es")}
                </span>
              ))}
            </div>
          )}

          {recipeLinkView && (
            <p style={{ marginBottom: "16px" }}>
              <strong>{t("recipes.new.fields.source")}:</strong>{" "}
              <a href={recipeLinkView} target="_blank" rel="noopener noreferrer">
                {t("recipes.detail.sourceOpen")}
              </a>
            </p>
          )}

          {recipe.ingredients && recipe.ingredients.length > 0 && (
            <div style={{ marginBottom: "20px" }}>
              <h3 style={{ marginBottom: "10px" }}>{t("recipes.new.fields.ingredients")}</h3>
              <ul style={{ paddingLeft: "20px" }}>
                {recipe.ingredients.map((item, index) => (
                  <li key={index}>
                    {(() => {
                      const detectedIngredientId =
                        item.ingredientId ||
                        findIngredientIdByName(item.name, "ru") ||
                        findIngredientIdByName(item.name, "en") ||
                        findIngredientIdByName(item.name, "es") ||
                        "";
                      const localizedName = getIngredientNameById(detectedIngredientId, locale, item.name);
                      const localizedUnit = getUnitLabel(item.unitId || item.unit, locale, item.unit);
                      return isTasteLikeUnit(item.unitId || item.unit)
                        ? `${localizedName} — ${t("recipes.detail.taste")}`
                        : `${item.amount} ${localizedUnit} ${localizedName}`;
                    })()}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {cookingText && (
            <div style={{ marginBottom: "20px" }}>
              <h3 style={{ marginBottom: "10px" }}>{t("recipes.new.fields.instructions")}</h3>
              <div className="card" style={{ padding: "12px", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                <LinkifiedText text={cookingText} />
              </div>
            </div>
          )}

          {canEdit && recipe.notes && (
            <div style={{ marginBottom: "20px" }}>
              <h3 style={{ marginBottom: "10px" }}>{t("recipes.new.fields.notes")}</h3>
              <div className="card" style={{ padding: "12px" }}>{recipe.notes}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
