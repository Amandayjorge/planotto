"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import {
  copyPublicRecipeToMine,
  deleteRecipe,
  deleteAllMyRecipes,
  getCurrentUserId,
  importLocalRecipesIfNeeded,
  listPublicAuthorProfiles,
  type PublicAuthorProfile,
  listSeedTemplateRecipes,
  listMyRecipes,
  loadLocalRecipes,
  removeRecipeFromLocalCache,
  syncRecipesToLocalCache,
  updateRecipe,
  updateRecipePersonalTags,
  upsertRecipeInLocalCache,
  type RecipeModel,
  type RecipeLanguage,
  type RecipeVisibility,
} from "../lib/recipesSupabase";
import { getSupabaseClient, isSupabaseConfigured } from "../lib/supabaseClient";
import { usePlanTier } from "../lib/usePlanTier";
import { isPaidFeatureEnabled } from "../lib/subscription";
import { RECIPE_TAGS, localizeRecipeTag, normalizeRecipeTags } from "../lib/recipeTags";
import { useI18n } from "../components/I18nProvider";
import { usePlanottoConfirm } from "../components/usePlanottoConfirm";
import { downloadPdfExport } from "../lib/pdfExportClient";
import { resolveRecipeImageForCard } from "../lib/recipeImageCatalog";
import { readProfileGoalFromStorage, type ProfileGoal } from "../lib/profileGoal";
import { encodeRecipeShareBundle } from "../lib/recipeShareBundle";
import { hasInappropriateRecipeContent, INAPPROPRIATE_CONTENT_MESSAGE } from "../lib/contentModeration";

type ViewMode = "mine" | "public";
type SortOption =
  | "newest"
  | "oldest"
  | "title_asc"
  | "title_desc"
  | "often_cooked"
  | "rarely_cooked";

const RECIPES_FIRST_FLOW_KEY = "recipesFirstFlowActive";
const FIRST_RECIPE_ADDED_KEY = "recipes:first-added-recipe-id";
const FIRST_RECIPE_SUCCESS_SHOWN_KEY = "recipes:first-success-shown";
const FIRST_RECIPE_SUCCESS_PENDING_KEY = "recipes:first-success-pending";
const FIRST_RECIPE_CREATE_FLOW_KEY = "recipes:first-create-flow";
const GUEST_RECIPES_REMINDER_DISMISSED_KEY = "recipes:guest-register-reminder-dismissed";
const GUEST_RECIPES_REMINDER_THRESHOLD = 3;
const MENU_RANGE_STATE_KEY = "selectedMenuRange";
const MENU_ADD_TO_MENU_PROMPT_KEY = "menuAddToMenuPromptEnabled";
const ACTIVE_PRODUCTS_STORAGE_PREFIX = "activeProducts:";
const PANTRY_STORAGE_KEY = "pantry";
const PERSONAL_TAGS_HINT_SEEN_KEY = "recipes:personal-tags-hint-seen";
const PERSONAL_TAG_MAX_LENGTH = 32;
const PERSONAL_TAG_MAX_COUNT = 12;
const ADD_TO_MENU_PROMPT_AUTO_CLOSE_MS = 4000;
const LEGACY_RECIPE_LANGUAGE_PREFERENCE_KEY = "recipes:language-preference";
const LANGUAGE_FILTER_MODE_KEY = "recipes:language-filter-mode";
const AVAILABLE_RECIPE_LANGUAGES: RecipeLanguage[] = ["ru", "en", "es"];

type LanguageFilterMode = "interface" | "interfaceEnglish" | "all";
const DEFAULT_LANGUAGE_FILTER_MODE: LanguageFilterMode = "interface";
const LANGUAGE_FILTER_OPTIONS: LanguageFilterMode[] = ["interface", "interfaceEnglish", "all"];

const VISIBILITY_BADGE_META: Record<
  Exclude<RecipeVisibility, "private">,
  { titleKey: string; emoji: string }
> = {
  public: {
    titleKey: "recipes.visibility.publicTitle",
    emoji: "🌍",
  },
  link: {
    titleKey: "recipes.visibility.linkTitle",
    emoji: "🔗",
  },
  invited: {
    titleKey: "recipes.visibility.invitedTitle",
    emoji: "👥",
  },
};

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(value.trim());
}

function normalizeRecipeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePersonalTag(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizePersonalTagKey(value: string): string {
  return normalizePersonalTag(value).toLocaleLowerCase("ru-RU");
}

function parsePersonalTagsInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  raw
    .split(/[,\n;]+/g)
    .map((item) => normalizePersonalTag(item))
    .filter(Boolean)
    .forEach((tag) => {
      const key = normalizePersonalTagKey(tag);
      if (!key || seen.has(key)) return;
      seen.add(key);
      result.push(tag);
    });
  return result;
}

function normalizeRecipeLanguage(value: unknown): RecipeLanguage {
  return value === "ru" || value === "en" || value === "es" ? value : "ru";
}

const UUID_LIKE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidLike(value: string): boolean {
  return UUID_LIKE_PATTERN.test(value.trim());
}

function resolveRecipeLanguageFromLocale(locale: string): RecipeLanguage {
  const normalized = String(locale || "").toLowerCase();
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("en")) return "en";
  return "ru";
}

function getRecipeCanonicalTitle(recipe: RecipeModel): string {
  const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
  return recipe.translations?.[baseLanguage]?.title || recipe.title || "";
}

function getRecipeLocalizedContent(
  recipe: RecipeModel,
  language: RecipeLanguage
): {
  title: string;
  shortDescription: string;
  description: string;
  instructions: string;
} {
  const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
  const preferred = recipe.translations?.[language];
  const fallback = recipe.translations?.[baseLanguage];

  return {
    title: (preferred?.title || fallback?.title || recipe.title || "").trim(),
    shortDescription: (preferred?.shortDescription || fallback?.shortDescription || recipe.shortDescription || "").trim(),
    description: (preferred?.description || fallback?.description || recipe.description || "").trim(),
    instructions: (preferred?.instructions || fallback?.instructions || recipe.instructions || "").trim(),
  };
}

function normalizeMatchText(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseItemsList(raw: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const chunk of raw.split(/[,\n;]+/)) {
    const value = chunk.trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(value);
  }
  return items;
}

function resolveUserMetaValue(user: User | null | undefined, key: string, fallback = ""): string {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const raw = metadata[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return fallback;
}

function isValidDateKey(raw: unknown): raw is string {
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

function resolveActiveProductsStorageKey(): string | null {
  if (typeof window === "undefined") return null;

  try {
    const rawRange = localStorage.getItem(MENU_RANGE_STATE_KEY);
    if (rawRange) {
      const parsed = JSON.parse(rawRange) as { start?: unknown; end?: unknown };
      if (isValidDateKey(parsed?.start) && isValidDateKey(parsed?.end)) {
        return `${ACTIVE_PRODUCTS_STORAGE_PREFIX}${parsed.start}__${parsed.end}`;
      }
    }
  } catch {
    // ignore malformed range state
  }

  const candidateKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(ACTIVE_PRODUCTS_STORAGE_PREFIX)) {
      candidateKeys.push(key);
    }
  }

  if (candidateKeys.length === 0) return null;
  candidateKeys.sort();
  return candidateKeys[candidateKeys.length - 1];
}

function normalizePreferredRecipeLanguages(
  list: RecipeLanguage[],
  interfaceLanguage: RecipeLanguage
): RecipeLanguage[] {
  const seen = new Set<RecipeLanguage>();
  const normalized: RecipeLanguage[] = [];

  for (const language of list) {
    if (!AVAILABLE_RECIPE_LANGUAGES.includes(language) || seen.has(language)) continue;
    seen.add(language);
    normalized.push(language);
  }

  if (!seen.has(interfaceLanguage)) {
    return [interfaceLanguage, ...normalized];
  }

  if (normalized[0] === interfaceLanguage) {
    return normalized;
  }

  return [interfaceLanguage, ...normalized.filter((language) => language !== interfaceLanguage)];
}

function isLanguageFilterMode(value: unknown): value is LanguageFilterMode {
  return typeof value === "string" && LANGUAGE_FILTER_OPTIONS.includes(value as LanguageFilterMode);
}

function normalizeStoredRecipeLanguages(raw: unknown): RecipeLanguage[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<RecipeLanguage>();
  const normalized: RecipeLanguage[] = [];
  raw.forEach((value) => {
    if (typeof value !== "string") return;
    const lower = value.toLowerCase();
    if (!AVAILABLE_RECIPE_LANGUAGES.includes(lower as RecipeLanguage)) return;
    if (seen.has(lower as RecipeLanguage)) return;
    seen.add(lower as RecipeLanguage);
    normalized.push(lower as RecipeLanguage);
  });
  return normalized;
}

function resolveLanguageFilterModeFromPreferredList(
  raw: unknown,
  interfaceLanguage: RecipeLanguage
): LanguageFilterMode {
  const normalized = normalizeStoredRecipeLanguages(raw);
  const unique = new Set<RecipeLanguage>(normalized);
  if (!unique.has(interfaceLanguage)) {
    unique.add(interfaceLanguage);
  }

  const hasExtra = Array.from(unique).some((language) => {
    return language !== interfaceLanguage && language !== "en";
  });

  if (hasExtra) {
    return "all";
  }

  if (unique.has("en")) {
    return "interfaceEnglish";
  }

  return "interface";
}

function getLanguagesForFilterMode(mode: LanguageFilterMode, interfaceLanguage: RecipeLanguage): RecipeLanguage[] {
  if (mode === "interfaceEnglish") {
    return normalizePreferredRecipeLanguages([interfaceLanguage, "en"], interfaceLanguage);
  }
  if (mode === "all") {
    return normalizePreferredRecipeLanguages(
      [interfaceLanguage, ...AVAILABLE_RECIPE_LANGUAGES.filter((language) => language !== interfaceLanguage)],
      interfaceLanguage
    );
  }
  return [interfaceLanguage];
}

function loadActiveProductNamesForCurrentRange(): string[] {
  if (typeof window === "undefined") return [];
  const storageKey = resolveActiveProductsStorageKey();
  if (!storageKey) return [];

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const unique = new Map<string, string>();
    parsed.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const typed = item as { name?: unknown; hidden?: unknown };
      if (typed.hidden === true) return;
      if (typeof typed.name !== "string") return;
      const name = typed.name.trim();
      if (!name) return;
      const normalized = normalizeMatchText(name);
      if (!normalized) return;
      if (!unique.has(normalized)) {
        unique.set(normalized, name);
      }
    });

    return Array.from(unique.values());
  } catch {
    return [];
  }
}

function loadPantryProductNames(): string[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const unique = new Map<string, string>();
    parsed.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const typed = item as { name?: unknown };
      if (typeof typed.name !== "string") return;
      const name = typed.name.trim();
      if (!name) return;
      const normalized = normalizeMatchText(name);
      if (!normalized) return;
      if (!unique.has(normalized)) {
        unique.set(normalized, name);
      }
    });

    return Array.from(unique.values());
  } catch {
    return [];
  }
}

function recipeHasProductMatch(ingredientNames: string[], productName: string): boolean {
  const normalizedProduct = normalizeMatchText(productName);
  if (!normalizedProduct) return false;

  return ingredientNames.some((ingredientName) => {
    if (!ingredientName) return false;
    if (ingredientName.includes(normalizedProduct) || normalizedProduct.includes(ingredientName)) return true;

    const productWords = normalizedProduct.split(" ").filter((word) => word.length >= 3);
    if (productWords.length === 0) return false;
    return productWords.every((word) => ingredientName.includes(word));
  });
}

function toErrorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const text = String((error as { message?: unknown }).message || "");
    if (text) return text;
  }
  return fallback;
}

function generateShareToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function toRecipeUpsertInput(recipe: RecipeModel, overrides?: Partial<RecipeModel>) {
  const next = { ...recipe, ...(overrides || {}) };
  return {
    title: next.title,
    shortDescription: next.shortDescription || "",
    description: next.description || "",
    instructions: next.instructions || next.description || "",
    ingredients: next.ingredients || [],
    notes: next.notes || "",
    servings: next.servings || 2,
    image: next.image || "",
    categories: [...(next.tags || next.categories || [])],
    tags: [...(next.tags || next.categories || [])],
    baseLanguage: normalizeRecipeLanguage(next.baseLanguage),
    translations: next.translations,
    visibility: next.visibility,
    shareToken: next.shareToken || "",
  };
}

function isAddToMenuPromptEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(MENU_ADD_TO_MENU_PROMPT_KEY) !== "0";
}

function isMissingRecipesTableError(error: unknown): boolean {
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
}

function isSeedTemplateId(recipeId: string | null | undefined): boolean {
  return String(recipeId || "").trim().toLowerCase().startsWith("seed-");
}

function resolveRecipeCardImage(recipe: RecipeModel): string | null {
  const resolved = resolveRecipeImageForCard({
    id: recipe.id,
    title: getRecipeCanonicalTitle(recipe),
    image: recipe.image,
    type: recipe.type,
    isTemplate: recipe.isTemplate,
  });
  return resolved || null;
}

function inferMealFromRecipeForMenu(
  recipe: Partial<Pick<RecipeModel, "title" | "shortDescription" | "categories" | "tags">> | null | undefined
): string {
  const text = [
    recipe?.title || "",
    recipe?.shortDescription || "",
    ...(recipe?.categories || []),
    ...(recipe?.tags || []),
  ]
    .join(" ")
    .toLocaleLowerCase("ru-RU");

  if (/(завтрак|утрен|каша|омлет|олад|блин|breakfast|desayuno)/u.test(text)) return "Завтрак";
  if (/(обед|суп|lunch|almuerzo|comida)/u.test(text)) return "Обед";
  if (/(ужин|вечер|dinner|cena)/u.test(text)) return "Ужин";
  return "Ужин";
}

function findRecipeInLocalCacheById(recipeId: string): RecipeModel | null {
  if (typeof window === "undefined") return null;
  try {
    return loadLocalRecipes().find((item) => item.id === recipeId) || null;
  } catch {
    return null;
  }
}

function resolveUserName(user: User | null | undefined): string | null {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const rawName =
    metadata.full_name ?? metadata.name ?? metadata.nickname ?? metadata.user_name;

  if (typeof rawName === "string" && rawName.trim()) {
    return rawName.trim();
  }

  const email = user?.email || "";
  const firstPart = email.split("@")[0] || "";
  const normalized = firstPart.replace(/[._-]+/g, " ").trim();
  if (!normalized) return null;

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function resolveUserAvatar(user: User | null | undefined): string | null {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const rawAvatar = metadata.avatar_url ?? metadata.picture;
  if (typeof rawAvatar === "string" && rawAvatar.trim()) {
    return rawAvatar.trim();
  }
  return null;
}

function resolveUserFrame(user: User | null | undefined): string | null {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const rawFrame = metadata.avatar_frame;
  if (typeof rawFrame === "string" && rawFrame.trim()) {
    return rawFrame.trim();
  }
  return null;
}

function RecipesPageContent() {
  const { locale, t } = useI18n();
  const { confirm, confirmDialog } = usePlanottoConfirm();
  const { planTier } = usePlanTier();
  const router = useRouter();
  const searchParams = useSearchParams();
  const uiRecipeLanguage = useMemo(() => resolveRecipeLanguageFromLocale(locale), [locale]);

  const [recipes, setRecipes] = useState<RecipeModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [languageFilterMode, setLanguageFilterMode] = useState<LanguageFilterMode>(DEFAULT_LANGUAGE_FILTER_MODE);
  const languageFilterLoaded = useRef(false);
  const [onlyWithPhoto, setOnlyWithPhoto] = useState(false);
  const [onlyWithNotes, setOnlyWithNotes] = useState(false);
  const [onlyWithActiveProducts, setOnlyWithActiveProducts] = useState(false);
  const [onlyFromPantry, setOnlyFromPantry] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("public");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string | null>(null);
  const [currentUserAvatar, setCurrentUserAvatar] = useState<string | null>(null);
  const [currentUserFrame, setCurrentUserFrame] = useState<string | null>(null);
  const [profileAllergiesList, setProfileAllergiesList] = useState<string[]>([]);
  const [profileDislikesList, setProfileDislikesList] = useState<string[]>([]);
  const [actionMessage, setActionMessage] = useState("");
  const [pendingCopyRecipeId, setPendingCopyRecipeId] = useState<string | null>(null);
  const [mineSyncVersion, setMineSyncVersion] = useState(0);
  const [justAddedRecipeTitles, setJustAddedRecipeTitles] = useState<Record<string, boolean>>({});
  const [addToMenuPromptRecipeId, setAddToMenuPromptRecipeId] = useState<string | null>(null);
  const [showFirstRecipeSuccess, setShowFirstRecipeSuccess] = useState(false);
  const [isFirstRecipeFlow, setIsFirstRecipeFlow] = useState(false);
  const [firstCopiedRecipeId, setFirstCopiedRecipeId] = useState<string | null>(null);
  const [showGuestRegisterReminder, setShowGuestRegisterReminder] = useState(false);
  const [activeProductNames, setActiveProductNames] = useState<string[]>([]);
  const [pantryProductNames, setPantryProductNames] = useState<string[]>([]);
  const [openActiveMatchesRecipeId, setOpenActiveMatchesRecipeId] = useState<string | null>(null);
  const [openDislikeRecipeId, setOpenDislikeRecipeId] = useState<string | null>(null);
  const [selectedRecipeIds, setSelectedRecipeIds] = useState<Record<string, boolean>>({});
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isSharingSelection, setIsSharingSelection] = useState(false);
  const [isSendingSelectionLink, setIsSendingSelectionLink] = useState(false);
  const [publicAuthorProfiles, setPublicAuthorProfiles] = useState<Record<string, PublicAuthorProfile>>({});
  const [selectedPersonalTagFilters, setSelectedPersonalTagFilters] = useState<string[]>([]);
  const [personalTagEditorRecipeId, setPersonalTagEditorRecipeId] = useState<string | null>(null);
  const [personalTagDraft, setPersonalTagDraft] = useState("");
  const [savingPersonalTagsRecipeId, setSavingPersonalTagsRecipeId] = useState<string | null>(null);
  const [showPersonalTagsHint, setShowPersonalTagsHint] = useState(false);
  const [isExportingRecipesPdf, setIsExportingRecipesPdf] = useState(false);
  const [showPdfProPrompt, setShowPdfProPrompt] = useState(false);
  const [profileGoal, setProfileGoal] = useState<ProfileGoal>("menu");
  const canUseAdvancedFilters = isPaidFeatureEnabled(planTier, "advanced_filters");
  const canUsePdfExport = isPaidFeatureEnabled(planTier, "pdf_export");
  const effectiveSelectedTags = canUseAdvancedFilters ? selectedTags : [];
  const effectiveOnlyWithPhoto = canUseAdvancedFilters ? onlyWithPhoto : false;
  const effectiveOnlyWithNotes = canUseAdvancedFilters && viewMode === "mine" ? onlyWithNotes : false;
  const effectiveOnlyWithActiveProducts = canUseAdvancedFilters ? onlyWithActiveProducts : false;
  const effectiveOnlyFromPantry = canUseAdvancedFilters ? onlyFromPantry : false;
  const effectiveSortBy: SortOption = canUseAdvancedFilters
    ? sortBy
    : (sortBy === "often_cooked" || sortBy === "rarely_cooked" ? "newest" : sortBy);

  const hasLanguageVariant = (recipe: RecipeModel, language: RecipeLanguage): boolean => {
    const normalizedBase = normalizeRecipeLanguage(recipe.baseLanguage);
    if (normalizedBase === language) return true;
    if (recipe.translations?.[language]) return true;
    return false;
  };

  const effectivePreferredRecipeLanguages = useMemo(
    () => getLanguagesForFilterMode(languageFilterMode, uiRecipeLanguage),
    [languageFilterMode, uiRecipeLanguage]
  );

  const getPreferredRecipeLanguage = useCallback(
    (recipe: RecipeModel): RecipeLanguage | null =>
      effectivePreferredRecipeLanguages.find((language) => hasLanguageVariant(recipe, language)) ?? null,
    [effectivePreferredRecipeLanguages]
  );

  const passesPreferredLanguages = (recipe: RecipeModel): boolean => {
    if (languageFilterMode === "all") return true;
    return effectivePreferredRecipeLanguages.some((language) => hasLanguageVariant(recipe, language));
  };

  const importedForUser = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || languageFilterLoaded.current) return;
    languageFilterLoaded.current = true;
    const stored = window.localStorage.getItem(LANGUAGE_FILTER_MODE_KEY);
    if (isLanguageFilterMode(stored)) {
      setLanguageFilterMode(stored);
      return;
    }
    const legacy = window.localStorage.getItem(LEGACY_RECIPE_LANGUAGE_PREFERENCE_KEY);
    if (!legacy) return;
    try {
      const parsed = JSON.parse(legacy);
      const mode = resolveLanguageFilterModeFromPreferredList(parsed, uiRecipeLanguage);
      setLanguageFilterMode(mode);
    } catch {
      // ignore malformed legacy value
    }
  }, [uiRecipeLanguage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LANGUAGE_FILTER_MODE_KEY, languageFilterMode);
  }, [languageFilterMode]);

  useEffect(() => {
    if (canUseAdvancedFilters) return;
    if (sortBy === "often_cooked" || sortBy === "rarely_cooked") {
      setSortBy("newest");
    }
    setOnlyWithPhoto(false);
    setOnlyWithNotes(false);
    setOnlyWithActiveProducts(false);
    setOnlyFromPantry(false);
    setSelectedTags([]);
    setShowAdvancedFilters(false);
  }, [canUseAdvancedFilters, sortBy]);

  useEffect(() => {
    if (canUsePdfExport) {
      setShowPdfProPrompt(false);
    }
  }, [canUsePdfExport]);

  useEffect(() => {
    if (viewMode === "mine") return;
    setIsSelectionMode(false);
    setSelectedRecipeIds({});
    setSelectedPersonalTagFilters([]);
    setPersonalTagEditorRecipeId(null);
    setPersonalTagDraft("");
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "mine") return;
    const recipeIdSet = new Set(recipes.map((item) => item.id));
    setSelectedRecipeIds((prev) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      Object.keys(prev).forEach((id) => {
        if (prev[id] && recipeIdSet.has(id)) {
          next[id] = true;
          return;
        }
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [recipes, viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (viewMode !== "mine" || isLoading || recipes.length === 0) return;
    if (localStorage.getItem(PERSONAL_TAGS_HINT_SEEN_KEY) === "1") return;
    setShowPersonalTagsHint(true);
  }, [isLoading, recipes.length, viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshProfileGoal = () => setProfileGoal(readProfileGoalFromStorage());
    refreshProfileGoal();
    window.addEventListener("storage", refreshProfileGoal);
    window.addEventListener("focus", refreshProfileGoal);
    return () => {
      window.removeEventListener("storage", refreshProfileGoal);
      window.removeEventListener("focus", refreshProfileGoal);
    };
  }, []);

  useEffect(() => {
    if (profileGoal !== "recipes") return;
    if (canUseAdvancedFilters) {
      setShowAdvancedFilters(true);
    }
  }, [canUseAdvancedFilters, profileGoal]);

  const refreshRecipes = async (mode: ViewMode, userId: string | null): Promise<void> => {
    setIsLoading(true);
    const localMine = () => loadLocalRecipes().filter((item) => !isSeedTemplateId(item.id));

    try {
      if (!isSupabaseConfigured()) {
        setRecipes(mode === "public" ? listSeedTemplateRecipes() : localMine());
        return;
      }

      if (mode === "mine") {
        if (!userId) {
          setRecipes(localMine());
          return;
        }
        const localSnapshot = localMine();
        if (localSnapshot.length > 0) {
          // Show cached list immediately while cloud sync is in progress.
          setRecipes(localSnapshot);
        }

        try {
          if (importedForUser.current !== userId) {
            await importLocalRecipesIfNeeded(userId);
            importedForUser.current = userId;
          }

          const mine = await listMyRecipes(userId);
          setRecipes(mine);
          syncRecipesToLocalCache(mine);
          return;
        } catch (mineError) {
          if (isMissingRecipesTableError(mineError)) {
            setRecipes(localMine());
            setActionMessage(t("recipes.messages.localMode"));
            return;
          }
          throw mineError;
        }
      }

      setRecipes(listSeedTemplateRecipes());
    } catch (requestError) {
      console.error("[recipes] failed to load recipes", requestError);
      setRecipes(mode === "public" ? listSeedTemplateRecipes() : localMine());
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setProfileAllergiesList([]);
      setProfileDislikesList([]);
      refreshRecipes(viewMode, null);
      return;
    }

    const supabase = getSupabaseClient();

    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id || null);
      setCurrentUserEmail(data.user?.email || null);
      setCurrentUserName(resolveUserName(data.user));
      setCurrentUserAvatar(resolveUserAvatar(data.user));
      setCurrentUserFrame(resolveUserFrame(data.user));
      setProfileAllergiesList(parseItemsList(resolveUserMetaValue(data.user, "allergies", "")));
      setProfileDislikesList(parseItemsList(resolveUserMetaValue(data.user, "dislikes", "")));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUserId(session?.user?.id || null);
      setCurrentUserEmail(session?.user?.email || null);
      setCurrentUserName(resolveUserName(session?.user));
      setCurrentUserAvatar(resolveUserAvatar(session?.user));
      setCurrentUserFrame(resolveUserFrame(session?.user));
      setProfileAllergiesList(parseItemsList(resolveUserMetaValue(session?.user, "allergies", "")));
      setProfileDislikesList(parseItemsList(resolveUserMetaValue(session?.user, "dislikes", "")));
      importedForUser.current = null;
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const refreshPantry = () => {
      setPantryProductNames(loadPantryProductNames());
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (!event.key || event.key === PANTRY_STORAGE_KEY) {
        refreshPantry();
      }
    };

    refreshPantry();
    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("focus", refreshPantry);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("focus", refreshPantry);
    };
  }, []);

  useEffect(() => {
    const clearQueryParams = (keys: string[]) => {
      if (typeof window === "undefined") return;

      const url = new URL(window.location.href);
      let changed = false;

      keys.forEach((key) => {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      });

      if (!changed) return;

      const nextSearch = url.searchParams.toString();
      const nextUrl = nextSearch ? `${url.pathname}?${nextSearch}` : url.pathname;
      window.history.replaceState({}, "", nextUrl);
    };

    const runtimeParams =
      typeof window !== "undefined" ? new URLSearchParams(window.location.search) : searchParams;
    const fromQuery = runtimeParams.get("first") === "1";
    const firstAddedFromQuery = runtimeParams.get("firstAdded") === "1";
    const recipeFromQuery = runtimeParams.get("recipe");
    const firstAddedPendingFromStorage =
      typeof window !== "undefined" &&
      localStorage.getItem(FIRST_RECIPE_SUCCESS_PENDING_KEY) === "1";
    const firstAddedFromStorage =
      typeof window !== "undefined" ? localStorage.getItem(FIRST_RECIPE_ADDED_KEY) : null;
    const fromStorage =
      typeof window !== "undefined" && localStorage.getItem(RECIPES_FIRST_FLOW_KEY) === "1";
    const active = fromQuery || fromStorage;

    if (firstAddedFromQuery || firstAddedPendingFromStorage || !!firstAddedFromStorage) {
      setShowFirstRecipeSuccess(true);
      setIsFirstRecipeFlow(false);

      const recipeId = recipeFromQuery || firstAddedFromStorage;
      if (recipeId) {
        setFirstCopiedRecipeId(recipeId);
      }

      if (typeof window !== "undefined") {
        localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
        localStorage.removeItem(FIRST_RECIPE_ADDED_KEY);
        localStorage.removeItem(FIRST_RECIPE_SUCCESS_PENDING_KEY);
        localStorage.removeItem(FIRST_RECIPE_CREATE_FLOW_KEY);
        localStorage.setItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY, "1");
      }

      clearQueryParams(["firstAdded", "recipe", "first"]);
      return;
    }

    setIsFirstRecipeFlow(active);

    if (active && typeof window !== "undefined") {
      localStorage.setItem(RECIPES_FIRST_FLOW_KEY, "1");
    }

    if (fromQuery) {
      clearQueryParams(["first"]);
    }
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const queryFromUrl = (searchParams.get("q") || "").trim();
    if (!queryFromUrl) return;

    setSearchQuery(queryFromUrl);
    setViewMode(currentUserId ? "mine" : "public");

    const url = new URL(window.location.href);
    if (url.searchParams.has("q")) {
      url.searchParams.delete("q");
      const nextSearch = url.searchParams.toString();
      const nextUrl = nextSearch ? `${url.pathname}?${nextSearch}` : url.pathname;
      window.history.replaceState({}, "", nextUrl);
    }
  }, [currentUserId, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isLoading || showFirstRecipeSuccess) return;
    if (recipes.length !== 1) return;

    const shown = localStorage.getItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY) === "1";
    if (shown) return;

    const first = recipes[0];
    if (!first?.id) return;

    setShowFirstRecipeSuccess(true);
    setFirstCopiedRecipeId(first.id);
    setIsFirstRecipeFlow(false);
    localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
    localStorage.removeItem(FIRST_RECIPE_ADDED_KEY);
    localStorage.removeItem(FIRST_RECIPE_SUCCESS_PENDING_KEY);
    localStorage.removeItem(FIRST_RECIPE_CREATE_FLOW_KEY);
    localStorage.setItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY, "1");
  }, [isLoading, recipes, showFirstRecipeSuccess]);

  useEffect(() => {
    refreshRecipes(viewMode, currentUserId);
  }, [viewMode, currentUserId]);

  useEffect(() => {
    if (currentUserId) return;
    if (viewMode !== "mine") return;
    setViewMode("public");
  }, [currentUserId, viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isLoading) return;

    if (currentUserId) {
      setShowGuestRegisterReminder(false);
      return;
    }

    const dismissed = localStorage.getItem(GUEST_RECIPES_REMINDER_DISMISSED_KEY) === "1";
    const shouldShow =
      viewMode === "mine" &&
      recipes.length >= GUEST_RECIPES_REMINDER_THRESHOLD &&
      !dismissed &&
      !isFirstRecipeFlow &&
      !showFirstRecipeSuccess;

    setShowGuestRegisterReminder(shouldShow);
  }, [currentUserId, isFirstRecipeFlow, isLoading, recipes.length, showFirstRecipeSuccess, viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const refreshActiveProducts = () => {
      setActiveProductNames(loadActiveProductNamesForCurrentRange());
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (!event.key) {
        refreshActiveProducts();
        return;
      }
      if (event.key === MENU_RANGE_STATE_KEY || event.key.startsWith(ACTIVE_PRODUCTS_STORAGE_PREFIX)) {
        refreshActiveProducts();
      }
    };

    refreshActiveProducts();
    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("focus", refreshActiveProducts);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("focus", refreshActiveProducts);
    };
  }, []);

  const recipeActiveMatchMap = useMemo(() => {
    const activeNames = activeProductNames.filter((name) => normalizeMatchText(name).length > 0);
    const map = new Map<string, { matchCount: number; topMatches: string[]; extraMatches: number }>();
    if (activeNames.length === 0) {
      recipes.forEach((recipe) => {
        map.set(recipe.id, { matchCount: 0, topMatches: [], extraMatches: 0 });
      });
      return map;
    }

    recipes.forEach((recipe) => {
      const ingredientNames = (recipe.ingredients || [])
        .map((ingredient) => normalizeMatchText(ingredient.name || ""))
        .filter(Boolean);
      const matchedNames = activeNames.filter((productName) =>
        recipeHasProductMatch(ingredientNames, productName)
      );
      const topMatches = matchedNames.slice(0, 2);
      map.set(recipe.id, {
        matchCount: matchedNames.length,
        topMatches,
        extraMatches: Math.max(0, matchedNames.length - topMatches.length),
      });
    });

    return map;
  }, [activeProductNames, recipes]);

  const recipePreferenceMatchMap = useMemo(() => {
    const allergyNames = profileAllergiesList.filter((name) => normalizeMatchText(name).length > 0);
    const dislikeNames = profileDislikesList.filter((name) => normalizeMatchText(name).length > 0);
    const map = new Map<
      string,
      {
        allergyCount: number;
        dislikeCount: number;
        allergyMatches: string[];
        dislikeMatches: string[];
        topDislikes: string[];
        extraDislikes: number;
      }
    >();

    recipes.forEach((recipe) => {
      const ingredientNames = (recipe.ingredients || [])
        .map((ingredient) => normalizeMatchText(ingredient.name || ""))
        .filter(Boolean);
      const allergyMatches = allergyNames.filter((productName) =>
        recipeHasProductMatch(ingredientNames, productName)
      );
      const dislikeMatches = dislikeNames.filter((productName) =>
        recipeHasProductMatch(ingredientNames, productName)
      );
      const topDislikes = dislikeMatches.slice(0, 2);
      map.set(recipe.id, {
        allergyCount: allergyMatches.length,
        dislikeCount: dislikeMatches.length,
        allergyMatches,
        dislikeMatches,
        topDislikes,
        extraDislikes: Math.max(0, dislikeMatches.length - topDislikes.length),
      });
    });

    return map;
  }, [profileAllergiesList, profileDislikesList, recipes]);

  const recipePantryCoverageMap = useMemo(() => {
    const pantryNames = pantryProductNames.filter((name) => normalizeMatchText(name).length > 0);
    const map = new Map<string, { totalIngredients: number; matchedIngredients: number; isFullyCovered: boolean }>();

    recipes.forEach((recipe) => {
      const ingredientNames = Array.from(
        new Set(
          (recipe.ingredients || [])
            .map((ingredient) => normalizeMatchText(ingredient.name || ""))
            .filter(Boolean)
        )
      );

      if (ingredientNames.length === 0) {
        map.set(recipe.id, { totalIngredients: 0, matchedIngredients: 0, isFullyCovered: false });
        return;
      }

      const matchedIngredients = ingredientNames.filter((ingredientName) =>
        pantryNames.some((pantryName) => recipeHasProductMatch([ingredientName], pantryName))
      ).length;

      map.set(recipe.id, {
        totalIngredients: ingredientNames.length,
        matchedIngredients,
        isFullyCovered: matchedIngredients === ingredientNames.length,
      });
    });

    return map;
  }, [pantryProductNames, recipes]);

  const personalTagFilterOptions = useMemo(() => {
    if (viewMode !== "mine") return [] as Array<{ value: string; count: number }>;
    const counts = new Map<string, { value: string; count: number }>();
    recipes.forEach((recipe) => {
      (recipe.personalTags || []).forEach((rawTag) => {
        const tag = normalizePersonalTag(rawTag);
        const key = normalizePersonalTagKey(tag);
        if (!key) return;
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(key, { value: tag, count: 1 });
        }
      });
    });
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ru"));
  }, [recipes, viewMode]);

  const filteredRecipes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sortLocale = uiRecipeLanguage === "es" ? "es" : uiRecipeLanguage === "en" ? "en" : "ru";
    const getTimesCooked = (item: RecipeModel): number => {
      const value = (item as RecipeModel & { timesCooked?: number }).timesCooked;
      return Number.isFinite(value) ? Number(value) : 0;
    };

    const filtered = recipes.filter((item) => {
      const localized = getRecipeLocalizedContent(item, uiRecipeLanguage);
      const tagIds = new Set(normalizeRecipeTags(item.tags || item.categories || []));
      const passesTags = effectiveSelectedTags.every((tagId) => tagIds.has(tagId));
      if (!passesTags) return false;
      const hasPhoto = Boolean(resolveRecipeCardImage(item));
      if (effectiveOnlyWithPhoto && !hasPhoto) return false;
      if (effectiveOnlyWithNotes && !item.notes?.trim()) return false;
      if (effectiveOnlyWithActiveProducts && (recipeActiveMatchMap.get(item.id)?.matchCount || 0) === 0) return false;
      if (effectiveOnlyFromPantry && !recipePantryCoverageMap.get(item.id)?.isFullyCovered) return false;
      const canonicalTitleKey = normalizeRecipeTitle(getRecipeCanonicalTitle(item));
      if (viewMode === "public" && canonicalTitleKey && existingMineTitleSet.has(canonicalTitleKey)) {
        return false;
      }
      if (!passesPreferredLanguages(item)) return false;
      if (
        viewMode === "mine" &&
        selectedPersonalTagFilters.length > 0
      ) {
        const itemTagKeys = new Set((item.personalTags || []).map((tag) => normalizePersonalTagKey(tag)));
        const passesPersonalTags = selectedPersonalTagFilters.every((tag) =>
          itemTagKeys.has(normalizePersonalTagKey(tag))
        );
        if (!passesPersonalTags) return false;
      }
      if (viewMode === "public" && (recipePreferenceMatchMap.get(item.id)?.allergyCount || 0) > 0) return false;
      if (!query) return true;

      const title = localized.title.toLowerCase();
      const shortDescription = localized.shortDescription.toLowerCase();
      const description = localized.description.toLowerCase();
      const ingredientsText = (item.ingredients || [])
        .map((ingredient) => (ingredient.name || "").toLowerCase())
        .join(" ");
      const authorId = String(item.authorId || item.ownerId || "").trim();
      const authorDisplayName = (publicAuthorProfiles[authorId]?.displayName || "").toLowerCase();
      const fallbackAuthorName =
        viewMode === "mine" && currentUserName ? currentUserName.toLowerCase() : "";
      const authorSearch = authorDisplayName || fallbackAuthorName;

      return (
        title.includes(query) ||
        shortDescription.includes(query) ||
        description.includes(query) ||
        ingredientsText.includes(query) ||
        authorSearch.includes(query)
      );
    });

    filtered.sort((a, b) => {
      const aTitle = getRecipeLocalizedContent(a, uiRecipeLanguage).title.toLowerCase();
      const bTitle = getRecipeLocalizedContent(b, uiRecipeLanguage).title.toLowerCase();
      const aCreated = Date.parse(a.createdAt || "") || 0;
      const bCreated = Date.parse(b.createdAt || "") || 0;
      const aCooked = getTimesCooked(a);
      const bCooked = getTimesCooked(b);

      switch (effectiveSortBy) {
        case "oldest":
          return aCreated - bCreated;
        case "title_asc":
          return aTitle.localeCompare(bTitle, sortLocale);
        case "title_desc":
          return bTitle.localeCompare(aTitle, sortLocale);
        case "often_cooked":
          return bCooked - aCooked;
        case "rarely_cooked":
          return aCooked - bCooked;
        case "newest":
        default:
          return bCreated - aCreated;
      }
    });

    const decorated = filtered.map((item, index) => {
      const coverage = recipePantryCoverageMap.get(item.id);
      const totalIngredients = coverage?.totalIngredients || 0;
      const matchedIngredients = coverage?.matchedIngredients || 0;
      const coverageRatio =
        totalIngredients > 0 ? matchedIngredients / totalIngredients : 0;
      const dislikeCount = recipePreferenceMatchMap.get(item.id)?.dislikeCount || 0;

      return {
        item,
        index,
        matchCount: recipeActiveMatchMap.get(item.id)?.matchCount || 0,
        coverageRatio,
        dislikeCount,
      };
    });
    const matched = decorated
      .filter((row) => row.matchCount > 0)
      .sort(
        (a, b) =>
          b.matchCount - a.matchCount ||
          a.dislikeCount - b.dislikeCount ||
          b.coverageRatio - a.coverageRatio ||
          a.index - b.index
      );
    const rest = decorated
      .filter((row) => row.matchCount === 0)
      .sort((a, b) => a.dislikeCount - b.dislikeCount || b.coverageRatio - a.coverageRatio || a.index - b.index);

    const prioritizeRowsByLanguage = (rows: typeof decorated[]): typeof decorated[] => {
      if (effectivePreferredRecipeLanguages.length <= 1) return rows;
      const buckets = effectivePreferredRecipeLanguages.map(() => [] as typeof decorated[]);
      const fallback: typeof decorated[] = [];

      rows.forEach((row) => {
        const language = getPreferredRecipeLanguage(row.item);
        const index = language ? effectivePreferredRecipeLanguages.indexOf(language) : -1;
        if (index >= 0) {
          buckets[index].push(row);
        } else {
          fallback.push(row);
        }
      });

      const ordered = buckets.reduce<typeof decorated[]>((acc, bucket) => acc.concat(bucket), []);
      return [...ordered, ...fallback];
    };

    const prioritizedMatched = prioritizeRowsByLanguage(matched);
    const prioritizedRest = prioritizeRowsByLanguage(rest);

    return [...prioritizedMatched, ...prioritizedRest].map((row) => row.item);
  }, [
    effectiveOnlyFromPantry,
    effectiveOnlyWithActiveProducts,
    effectiveOnlyWithNotes,
    effectiveOnlyWithPhoto,
    effectiveSelectedTags,
    effectiveSortBy,
    recipeActiveMatchMap,
    recipePreferenceMatchMap,
    recipePantryCoverageMap,
    recipes,
    searchQuery,
    selectedPersonalTagFilters,
    uiRecipeLanguage,
    viewMode,
    existingMineTitleSet,
    effectivePreferredRecipeLanguages,
    getPreferredRecipeLanguage,
    publicAuthorProfiles,
    currentUserName,
  ]);

  useEffect(() => {
    let cancelled = false;

    const publicAuthorIds = Array.from(
      new Set(
        recipes
          .filter((recipe) => recipe.visibility === "public")
          .map((recipe) => String(recipe.authorId || recipe.ownerId || "").trim())
          .filter((authorId) => authorId.length > 0 && authorId !== "system" && isUuidLike(authorId))
      )
    );

    if (publicAuthorIds.length === 0) {
      setPublicAuthorProfiles({});
      return () => {
        cancelled = true;
      };
    }

    listPublicAuthorProfiles(publicAuthorIds)
      .then((profiles) => {
        if (cancelled) return;
        setPublicAuthorProfiles(profiles);
      })
      .catch(() => {
        if (cancelled) return;
        setPublicAuthorProfiles({});
      });

    return () => {
      cancelled = true;
    };
  }, [recipes]);

  const selectedMineRecipes = useMemo(
    () => recipes.filter((recipe) => Boolean(selectedRecipeIds[recipe.id])),
    [recipes, selectedRecipeIds]
  );

  const existingMineTitleSet = useMemo(() => {
    if (typeof window === "undefined") return new Set<string>();

    const source = (viewMode === "mine" ? recipes : loadLocalRecipes()).filter(
      (item) => !isSeedTemplateId(item.id)
    );
    return new Set(
      source
        .map((item) => normalizeRecipeTitle(getRecipeCanonicalTitle(item)))
        .filter(Boolean)
    );
  }, [mineSyncVersion, recipes, viewMode]);

  const existingMineByTitle = useMemo(() => {
    if (typeof window === "undefined") return new Map<string, string>();
    const source = loadLocalRecipes().filter((item) => !isSeedTemplateId(item.id));
    const map = new Map<string, string>();
    source.forEach((item) => {
      const key = normalizeRecipeTitle(getRecipeCanonicalTitle(item));
      if (!key || !item.id || map.has(key)) return;
      map.set(key, item.id);
    });
    return map;
  }, [mineSyncVersion, recipes, viewMode]);

  const openMenuWithRecipe = (recipeId: string) => {
    const recipeFromState = recipes.find((item) => item.id === recipeId) || null;
    const recipeForMenu = recipeFromState || findRecipeInLocalCacheById(recipeId);
    const params = new URLSearchParams({ recipe: recipeId });

    const recipeView = recipeForMenu ? getRecipeLocalizedContent(recipeForMenu, uiRecipeLanguage) : null;
    const recipeTitle = recipeView?.title?.trim();
    if (recipeTitle) {
      params.set("title", recipeTitle);
    }
    params.set(
      "meal",
      inferMealFromRecipeForMenu(
        recipeForMenu
          ? {
              ...recipeForMenu,
              title: recipeView?.title || recipeForMenu.title,
              shortDescription: recipeView?.shortDescription || recipeForMenu.shortDescription,
            }
          : null
      )
    );

    router.push("/menu?" + params.toString());
  };

  const showAddedFeedback = (title: string, recipeId: string) => {
    const key = normalizeRecipeTitle(title);
    if (key) {
      setJustAddedRecipeTitles((prev) => ({ ...prev, [key]: true }));
    }
    setMineSyncVersion((prev) => prev + 1);
    if (isAddToMenuPromptEnabled()) {
      setAddToMenuPromptRecipeId(recipeId);
    }
  };

  const handleCreateRecipe = () => {
    if (typeof window !== "undefined") {
      const shouldStartFirstFlow =
        isFirstRecipeFlow ||
        recipes.length === 0 ||
        searchParams.get("first") === "1" ||
        localStorage.getItem(RECIPES_FIRST_FLOW_KEY) === "1";

      if (shouldStartFirstFlow) {
        localStorage.setItem(RECIPES_FIRST_FLOW_KEY, "1");
        localStorage.setItem(FIRST_RECIPE_CREATE_FLOW_KEY, "1");
        localStorage.removeItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY);
        router.push("/recipes/new?firstCreate=1");
        return;
      }
    }

    router.push("/recipes/new");
  };

  const handleCreateFirstRecipe = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem(RECIPES_FIRST_FLOW_KEY, "1");
      localStorage.setItem(FIRST_RECIPE_CREATE_FLOW_KEY, "1");
      localStorage.removeItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY);
    }
    router.push("/recipes/new?firstCreate=1");
  };

  const handleDismissFirstRecipeSuccess = () => {
    setShowFirstRecipeSuccess(false);
    setIsFirstRecipeFlow(false);
    setFirstCopiedRecipeId(null);

    if (typeof window !== "undefined") {
      localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
      localStorage.removeItem(FIRST_RECIPE_CREATE_FLOW_KEY);
      localStorage.removeItem(FIRST_RECIPE_ADDED_KEY);
      localStorage.removeItem(FIRST_RECIPE_SUCCESS_PENDING_KEY);
      localStorage.setItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY, "1");
    }
  };

  const handleAddFirstRecipeToMenu = () => {
    if (!firstCopiedRecipeId) {
      handleDismissFirstRecipeSuccess();
      router.push("/menu");
      return;
    }

    handleDismissFirstRecipeSuccess();
    openMenuWithRecipe(firstCopiedRecipeId);
  };

  const handleConfirmAddedRecipeMenu = () => {
    if (!addToMenuPromptRecipeId) return;
    const recipeId = addToMenuPromptRecipeId;
    setAddToMenuPromptRecipeId(null);
    openMenuWithRecipe(recipeId);
  };

  const handleDismissAddedRecipeMenu = () => {
    setAddToMenuPromptRecipeId(null);
  };

  useEffect(() => {
    if (!addToMenuPromptRecipeId) return;
    if (typeof window === "undefined") return;

    const timer = window.setTimeout(() => {
      setAddToMenuPromptRecipeId((current) =>
        current === addToMenuPromptRecipeId ? null : current
      );
    }, ADD_TO_MENU_PROMPT_AUTO_CLOSE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [addToMenuPromptRecipeId]);

  const handleChooseReadyRecipe = () => {
    setViewMode("public");
    setActionMessage("");
    setIsFirstRecipeFlow(false);

    if (typeof window !== "undefined") {
      // Скрываем стартовую плашку сразу, но оставляем флоу "первый рецепт"
      // для следующего шага: показать "Отлично!" после добавления рецепта.
      localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
      localStorage.setItem(FIRST_RECIPE_CREATE_FLOW_KEY, "1");
      localStorage.removeItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY);
    }

    router.replace("/recipes");
  };

  const shouldShowFirstRecipeOverlay = (): boolean => {
    if (typeof window === "undefined") return isFirstRecipeFlow;
    return (
      isFirstRecipeFlow ||
      localStorage.getItem(RECIPES_FIRST_FLOW_KEY) === "1" ||
      localStorage.getItem(FIRST_RECIPE_CREATE_FLOW_KEY) === "1" ||
      localStorage.getItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY) !== "1"
    );
  };

  const showFirstRecipeOverlay = (recipeId: string) => {
    if (typeof window !== "undefined") {
      localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
      localStorage.removeItem(FIRST_RECIPE_CREATE_FLOW_KEY);
    }
    setIsFirstRecipeFlow(false);
    setShowFirstRecipeSuccess(true);
    setFirstCopiedRecipeId(recipeId);
    setActionMessage("");
    setViewMode("public");
  };

  const handleCopyToMine = async (recipeId: string) => {
    const source = recipes.find((item) => item.id === recipeId);
    if (!source) return;
    const allergyMeta = recipePreferenceMatchMap.get(recipeId);
    if ((allergyMeta?.allergyCount || 0) > 0) {
      const listed = (allergyMeta?.allergyMatches || []).slice(0, 3).join(", ");
      const warning = listed
        ? t("recipes.messages.allergyWarningMany", { listed })
        : t("recipes.messages.allergyWarningOne");
      const confirmed = await confirm({ message: warning });
      if (!confirmed) return;
    }
    setPendingCopyRecipeId(recipeId);
    const showOverlayForThisCopy = shouldShowFirstRecipeOverlay();
    const sourceTitleKey = normalizeRecipeTitle(getRecipeCanonicalTitle(source));
    const findExistingMineLocal = (): RecipeModel | null => {
      const existing = loadLocalRecipes().find((item) => {
        if (isSeedTemplateId(item.id)) return false;
        return normalizeRecipeTitle(getRecipeCanonicalTitle(item)) === sourceTitleKey;
      });
      return existing || null;
    };

    try {
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
          if (showOverlayForThisCopy) {
            showFirstRecipeOverlay(existingLocal.id);
          } else {
            showAddedFeedback(source.title || "", existingLocal.id);
          }
          return;
        }

        const localCopy: RecipeModel = {
          ...source,
          id: crypto.randomUUID(),
          ownerId: "",
          type: "user",
          isTemplate: false,
          visibility: "private",
          notes: source.notes || "",
        };

        upsertRecipeInLocalCache(localCopy);
        if (showOverlayForThisCopy) {
          showFirstRecipeOverlay(localCopy.id);
        } else {
          setActionMessage("");
          showAddedFeedback(source.title || "", localCopy.id);
        }
        return;
      }

      const existingLocal = findExistingMineLocal();
      if (existingLocal) {
        if (showOverlayForThisCopy) {
          showFirstRecipeOverlay(existingLocal.id);
        } else {
          showAddedFeedback(source.title || "", existingLocal.id);
        }
        return;
      }

      const copied = await copyPublicRecipeToMine(targetUserId, source.id);
      upsertRecipeInLocalCache(copied);
      if (showOverlayForThisCopy) {
        showFirstRecipeOverlay(copied.id);
      } else {
        setActionMessage("");
        showAddedFeedback(source.title || "", copied.id);
      }
    } catch (copyError) {
      if (isMissingRecipesTableError(copyError)) {
        const existingLocal = findExistingMineLocal();
        if (existingLocal) {
          if (showOverlayForThisCopy) {
            showFirstRecipeOverlay(existingLocal.id);
          } else {
            setActionMessage(t("recipes.messages.supabaseTableMissingAlreadyLocal"));
            showAddedFeedback(source.title || "", existingLocal.id);
          }
          return;
        }

        const localCopy: RecipeModel = {
          ...source,
          id: crypto.randomUUID(),
          ownerId: "",
          type: "user",
          isTemplate: false,
          visibility: "private",
          notes: source.notes || "",
        };
        upsertRecipeInLocalCache(localCopy);
        if (showOverlayForThisCopy) {
          showFirstRecipeOverlay(localCopy.id);
        } else {
          setActionMessage(t("recipes.messages.supabaseTableMissingAddedLocal"));
          showAddedFeedback(source.title || "", localCopy.id);
        }
        return;
      }
      const text = toErrorText(copyError, t("recipes.messages.copyFailed"));
      setActionMessage(text);
    } finally {
      setPendingCopyRecipeId((prev) => (prev === recipeId ? null : prev));
    }
  };

  const handleClearAllRecipes = async () => {
    const ok = await confirm({
      message: t("recipes.messages.clearAllConfirm"),
      tone: "danger",
    });
    if (!ok) return;

    setIsLoading(true);
    setActionMessage("");

    try {
      localStorage.removeItem("recipes");
      localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
      localStorage.removeItem(FIRST_RECIPE_CREATE_FLOW_KEY);
      localStorage.removeItem(FIRST_RECIPE_ADDED_KEY);
      localStorage.removeItem(FIRST_RECIPE_SUCCESS_PENDING_KEY);
      localStorage.removeItem(FIRST_RECIPE_SUCCESS_SHOWN_KEY);
      setShowFirstRecipeSuccess(false);
      setFirstCopiedRecipeId(null);

      let targetUserId = currentUserId;
      if (!targetUserId && isSupabaseConfigured()) {
        try {
          targetUserId = await getCurrentUserId();
          if (targetUserId) setCurrentUserId(targetUserId);
        } catch {
          targetUserId = null;
        }
      }
      if (isSupabaseConfigured() && targetUserId) {
        await deleteAllMyRecipes(targetUserId);
      }

      await refreshRecipes(viewMode, targetUserId || currentUserId);
      setActionMessage(t("recipes.messages.cleared"));
    } catch (clearError) {
      const text =
        clearError instanceof Error
          ? clearError.message
          : typeof clearError === "object" && clearError && "message" in clearError
            ? String((clearError as { message?: unknown }).message || t("recipes.messages.clearFailed"))
            : t("recipes.messages.clearFailed");
      setActionMessage(text);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteRecipe = async (recipe: RecipeModel) => {
    const localized = getRecipeLocalizedContent(recipe, uiRecipeLanguage);
    const ok = await confirm({
      message: t("recipes.messages.deleteOneConfirm", {
        title: localized.title || recipe.title || t("menu.fallback.recipeTitle"),
      }),
      tone: "danger",
    });
    if (!ok) return;

    try {
      const canDeleteInSupabase =
        isSupabaseConfigured() && !!currentUserId && !!recipe.ownerId && recipe.ownerId === currentUserId;

      if (canDeleteInSupabase) {
        await deleteRecipe(currentUserId as string, recipe.id);
      }

      removeRecipeFromLocalCache(recipe.id);
      setRecipes((prev) => prev.filter((item) => item.id !== recipe.id));
      setActionMessage(t("recipes.messages.deleted"));
    } catch (deleteError) {
      const text = deleteError instanceof Error ? deleteError.message : t("recipes.messages.deleteFailed");
      setActionMessage(text);
    }
  };

  const markPersonalTagsHintSeen = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem(PERSONAL_TAGS_HINT_SEEN_KEY, "1");
    }
    setShowPersonalTagsHint(false);
  };

  const savePersonalTagsForRecipe = async (recipe: RecipeModel, nextTagsRaw: string[]) => {
    const nextTags = Array.from(
      new Set(
        nextTagsRaw
          .map((item) => normalizePersonalTag(item))
          .filter((item) => item.length > 0)
      )
    );

    setSavingPersonalTagsRecipeId(recipe.id);
    try {
      let savedTags = nextTags;
      const canUseSupabaseMeta =
        isSupabaseConfigured() &&
        Boolean(currentUserId) &&
        recipe.ownerId === currentUserId;

      if (canUseSupabaseMeta) {
        savedTags = await updateRecipePersonalTags(currentUserId as string, recipe.id, nextTags);
      }

      const applyUpdate = (item: RecipeModel): RecipeModel =>
        item.id === recipe.id ? { ...item, personalTags: savedTags } : item;

      setRecipes((prev) => prev.map(applyUpdate));

      const localSnapshot = findRecipeInLocalCacheById(recipe.id);
      if (localSnapshot) {
        upsertRecipeInLocalCache({ ...localSnapshot, personalTags: savedTags });
      } else {
        upsertRecipeInLocalCache({ ...recipe, personalTags: savedTags });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : t("recipes.personalTags.saveFailed");
      setActionMessage(text);
    } finally {
      setSavingPersonalTagsRecipeId(null);
    }
  };

  const handleSavePersonalTag = async (recipe: RecipeModel) => {
    const parsed = parsePersonalTagsInput(personalTagDraft);
    if (parsed.length === 0) return;

    const tooLong = parsed.find((tag) => tag.length > PERSONAL_TAG_MAX_LENGTH);
    if (tooLong) {
      setActionMessage(t("recipes.personalTags.limitLength", { max: PERSONAL_TAG_MAX_LENGTH }));
      return;
    }

    const current = recipe.personalTags || [];
    const currentKeys = new Set(current.map((item) => normalizePersonalTagKey(item)));
    const toAdd = parsed.filter((tag) => !currentKeys.has(normalizePersonalTagKey(tag)));
    if (toAdd.length === 0) {
      setPersonalTagDraft("");
      setPersonalTagEditorRecipeId(null);
      markPersonalTagsHintSeen();
      return;
    }

    if (current.length + toAdd.length > PERSONAL_TAG_MAX_COUNT) {
      setActionMessage(t("recipes.personalTags.limitCount", { max: PERSONAL_TAG_MAX_COUNT }));
      return;
    }

    await savePersonalTagsForRecipe(recipe, [...current, ...toAdd]);
    setActionMessage("");
    setPersonalTagDraft("");
    setPersonalTagEditorRecipeId(null);
    markPersonalTagsHintSeen();
  };

  const handleRemovePersonalTag = async (recipe: RecipeModel, tagToRemove: string) => {
    const removeKey = normalizePersonalTagKey(tagToRemove);
    const next = (recipe.personalTags || []).filter((item) => normalizePersonalTagKey(item) !== removeKey);
    await savePersonalTagsForRecipe(recipe, next);
  };

  const handleMovePersonalTag = async (
    recipe: RecipeModel,
    tag: string,
    direction: "left" | "right"
  ) => {
    const current = [...(recipe.personalTags || [])];
    const targetKey = normalizePersonalTagKey(tag);
    const index = current.findIndex((item) => normalizePersonalTagKey(item) === targetKey);
    if (index < 0) return;

    const swapIndex = direction === "left" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= current.length) return;

    const next = [...current];
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    await savePersonalTagsForRecipe(recipe, next);
  };

  const accountNameView = currentUserName || t("recipes.account.guestName");
  const accountEmailView = currentUserEmail || t("recipes.account.tapToLogin");
  const accountInitial = accountNameView.charAt(0).toUpperCase() || "G";
  const isGuest = !currentUserId;
  const hasAnyRecipes = recipes.length > 0;
  const hasActiveFilters =
    effectiveSelectedTags.length > 0 ||
    effectiveOnlyWithPhoto ||
    effectiveOnlyWithNotes ||
    effectiveOnlyWithActiveProducts ||
    effectiveOnlyFromPantry ||
    (viewMode === "mine" && selectedPersonalTagFilters.length > 0) ||
    searchQuery.trim().length > 0;
  const showBlockingLoading = isLoading && recipes.length === 0;
  const isEmptyState = !isLoading && !hasAnyRecipes;
  const isFilteredEmpty = !isLoading && hasAnyRecipes && filteredRecipes.length === 0;
  const showFirstRecipePrompt = isFirstRecipeFlow && !showFirstRecipeSuccess;

  const handleDismissGuestRegisterReminder = () => {
    setShowGuestRegisterReminder(false);
    if (typeof window !== "undefined") {
      localStorage.setItem(GUEST_RECIPES_REMINDER_DISMISSED_KEY, "1");
    }
  };

  const exportSelectedRecipesPdf = async () => {
    if (!canUsePdfExport) {
      setShowPdfProPrompt(true);
      setActionMessage("");
      return;
    }
    setShowPdfProPrompt(false);
    if (selectedMineRecipes.length === 0) {
      setActionMessage(t("pdf.errors.selectRecipes"));
      return;
    }

    try {
      setIsExportingRecipesPdf(true);
      setActionMessage("");
      await downloadPdfExport({
        kind: "recipes",
        coverTitle: t("pdf.cover.recipes"),
        fileName: "planotto-recipes.pdf",
        recipes: selectedMineRecipes.map((recipe) => {
          const localized = getRecipeLocalizedContent(recipe, uiRecipeLanguage);
          const stepLines = String(localized.instructions || localized.description || "")
            .split(/\n+/g)
            .map((line) => line.trim())
            .filter(Boolean);
          return {
            title: String(localized.title || recipe.title || t("menu.fallback.recipeTitle")).trim(),
            servings: recipe.servings || 2,
            cookingTime:
              [...(recipe.tags || []), ...(recipe.categories || [])].find((value) =>
                /\d+\s*(мин|min|ч|hour|hr)/i.test(value || "")
              ) || undefined,
            ingredients: (recipe.ingredients || []).map((item) =>
              `${item.amount} ${item.unit} ${item.name}`.trim()
            ),
            steps: stepLines.length > 0 ? stepLines : [t("pdf.fallback.noSteps")],
          };
        }),
      });
    } catch (error) {
      const text = toErrorText(error, t("pdf.errors.exportFailed"));
      setActionMessage(text);
    } finally {
      setIsExportingRecipesPdf(false);
    }
  };

  const toggleRecipeSelection = (recipeId: string, checked: boolean) => {
    setSelectedRecipeIds((prev) => {
      if (checked) return { ...prev, [recipeId]: true };
      const next = { ...prev };
      delete next[recipeId];
      return next;
    });
  };

  const enterSelectionMode = () => {
    setIsSelectionMode(true);
    setActionMessage("");
  };

  const exitSelectionMode = () => {
    setIsSelectionMode(false);
    setSelectedRecipeIds({});
    setActionMessage("");
  };

  const shareSelectedRecipesPublic = async () => {
    if (selectedMineRecipes.length === 0) {
      setActionMessage(t("recipes.selection.selectAtLeastOne"));
      return;
    }
    if (!currentUserId) {
      setActionMessage(t("recipes.selection.requireAccount"));
      return;
    }

    const hasBlockedContent = selectedMineRecipes
      .filter((recipe) => recipe.visibility !== "public")
      .some((recipe) =>
        hasInappropriateRecipeContent({
          title: recipe.title,
          shortDescription: recipe.shortDescription,
          description: recipe.description,
          instructions: recipe.instructions,
          notes: recipe.notes,
          tags: recipe.tags || recipe.categories,
          ingredients: recipe.ingredients,
        })
      );
    if (hasBlockedContent) {
      setActionMessage(t("recipes.new.messages.inappropriateContent") || INAPPROPRIATE_CONTENT_MESSAGE);
      return;
    }

    try {
      setIsSharingSelection(true);
      setActionMessage("");
      const updates = await Promise.all(
        selectedMineRecipes.map(async (recipe) => {
          if (recipe.visibility === "public") return recipe;
          const updated = await updateRecipe(
            currentUserId,
            recipe.id,
            toRecipeUpsertInput(recipe, { visibility: "public", shareToken: "" })
          );
          upsertRecipeInLocalCache(updated);
          return updated;
        })
      );

      const updatedById = new Map(updates.map((recipe) => [recipe.id, recipe]));
      const nextRecipes = recipes.map((recipe) => updatedById.get(recipe.id) || recipe);
      setRecipes(nextRecipes);
      syncRecipesToLocalCache(nextRecipes);
      setActionMessage(t("recipes.selection.sharedPublic", { count: updates.length }));
    } catch (error) {
      const text = toErrorText(error, t("recipes.selection.shareFailed"));
      setActionMessage(text);
    } finally {
      setIsSharingSelection(false);
    }
  };

  const sendSelectedRecipesByLink = async () => {
    if (selectedMineRecipes.length === 0) {
      setActionMessage(t("recipes.selection.selectAtLeastOne"));
      return;
    }
    if (!currentUserId || !isSupabaseConfigured()) {
      setActionMessage(t("recipes.selection.linkRequiresCloud"));
      return;
    }
    if (typeof window === "undefined") return;

    try {
      setIsSendingSelectionLink(true);
      setActionMessage("");
      const updates = await Promise.all(
        selectedMineRecipes.map(async (recipe) => {
          const token = String(recipe.shareToken || "").trim() || generateShareToken();
          if (recipe.visibility === "link" && token === String(recipe.shareToken || "").trim()) {
            return { recipe, token };
          }
          const updated = await updateRecipe(
            currentUserId,
            recipe.id,
            toRecipeUpsertInput(recipe, { visibility: "link", shareToken: token })
          );
          upsertRecipeInLocalCache(updated);
          return { recipe: updated, token: String(updated.shareToken || token).trim() };
        })
      );

      const updatedById = new Map(updates.map(({ recipe }) => [recipe.id, recipe]));
      const nextRecipes = recipes.map((recipe) => updatedById.get(recipe.id) || recipe);
      setRecipes(nextRecipes);
      syncRecipesToLocalCache(nextRecipes);

      const bundle = encodeRecipeShareBundle(
        updates.map(({ recipe, token }) => ({
          id: recipe.id,
          token,
        }))
      );
      const shareUrl = `${window.location.origin}/recipes/share?items=${encodeURIComponent(bundle)}`;
      await navigator.clipboard.writeText(shareUrl);
      setActionMessage(t("recipes.selection.linkCopied"));
    } catch (error) {
      const text = toErrorText(error, t("recipes.selection.linkFailed"));
      setActionMessage(text);
    } finally {
      setIsSendingSelectionLink(false);
    }
  };

  return (
    <>
      {showFirstRecipePrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("recipes.onboarding.firstRecipeAria")}
          className="menu-first-onboarding"
        >
          <div className="menu-first-onboarding__card" style={{ width: "min(500px, 100%)" }}>
            <img
              src="/mascot/pages/recipes-onboarding.png"
              alt=""
              aria-hidden="true"
              className="menu-first-onboarding__mascot"
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = "/mascot/pages/recipes.png";
              }}
            />
            <h2 className="menu-first-onboarding__title">{t("recipes.onboarding.title")}</h2>
            <p className="menu-first-onboarding__text">
              {t("recipes.onboarding.description")}
            </p>
            <div className="menu-first-onboarding__actions">
              <button type="button" className="btn btn-primary" onClick={handleChooseReadyRecipe}>
                {t("recipes.onboarding.chooseReady")}
              </button>
              <button
                type="button"
                onClick={handleCreateFirstRecipe}
                className="menu-first-onboarding__skip"
              >
                {t("recipes.onboarding.addOwn")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: "20px", maxWidth: "920px", margin: "0 auto" }}>
      <div className="recipes-topbar">
        <div className="recipes-topbar__actions">
          <button className="btn" onClick={() => router.push("/menu")}>
            {t("recipes.actions.backToMenu")}
          </button>
          {!isGuest ? (
            <button className="btn btn-add" onClick={handleCreateRecipe}>
              {t("recipes.actions.addRecipe")}
            </button>
          ) : null}
          </div>
        <button className="recipes-account-chip" onClick={() => router.push("/auth")}>
          <span
            className={`recipes-account-chip__avatar ${
              currentUserFrame ? "recipes-account-chip__avatar--has-frame" : ""
            }`.trim()}
          >
            {currentUserAvatar ? (
              <img
                src={currentUserAvatar}
                alt={t("recipes.account.avatarAlt")}
                className={`recipes-account-chip__avatar-image ${
                  currentUserFrame ? "recipes-account-chip__avatar-image--framed" : ""
                }`}
              />
            ) : (
              <span className="recipes-account-chip__avatar-initial">{accountInitial}</span>
            )}
            {currentUserFrame ? (
              <img
                src={currentUserFrame}
                alt={t("recipes.account.frameAlt")}
                className="recipes-account-chip__avatar-frame"
              />
            ) : null}
          </span>
          <span className="recipes-account-chip__content">
            <span className="recipes-account-chip__meta">
              {currentUserEmail ? t("recipes.account.accountLabel") : t("recipes.account.authLabel")}
            </span>
            <span className="recipes-account-chip__name" title={accountNameView}>
              {accountNameView}
            </span>
            <span className="recipes-account-chip__email" title={accountEmailView}>
              {accountEmailView}
            </span>
          </span>
        </button>
      </div>

      <h1 className="h1" style={{ marginBottom: "20px" }}>
        {t("recipes.title")}
      </h1>

      <div style={{ marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {!isGuest ? (
          <button
            type="button"
            className={`btn ${viewMode === "mine" ? "btn-primary" : ""}`}
            onClick={() => setViewMode("mine")}
          >
            {t("recipes.tabs.mine")}
          </button>
        ) : null}
        <button
          type="button"
          className={`btn ${viewMode === "public" ? "btn-primary" : ""}`}
          onClick={() => setViewMode("public")}
        >
          {t("recipes.tabs.public")}
        </button>
      </div>
      {isGuest ? (
        <div className="card" style={{ marginTop: "-4px", marginBottom: "12px", padding: "10px 12px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted">🔒 {t("recipes.guestMode.notice")}</span>
            <button type="button" className="btn btn-primary" onClick={() => router.push("/auth")}>
              {t("recipes.guestReminder.createAccount")}
            </button>
          </div>
        </div>
      ) : null}
      {viewMode === "mine" && hasAnyRecipes ? (
        isSelectionMode ? (
          <div className="card" style={{ marginTop: "-4px", marginBottom: "12px", padding: "10px 12px" }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "14px" }}>
                {t("recipes.selection.count", { count: selectedMineRecipes.length })}
              </strong>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void shareSelectedRecipesPublic();
                  }}
                  disabled={isSharingSelection || isSendingSelectionLink || isExportingRecipesPdf}
                >
                  {isSharingSelection ? t("recipes.selection.sharing") : t("recipes.selection.share")}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void exportSelectedRecipesPdf();
                  }}
                  disabled={isExportingRecipesPdf || isSharingSelection || isSendingSelectionLink}
                >
                  {isExportingRecipesPdf ? t("pdf.actions.exporting") : t("recipes.selection.exportPdf")}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void sendSelectedRecipesByLink();
                  }}
                  disabled={isSendingSelectionLink || isSharingSelection || isExportingRecipesPdf}
                >
                  {isSendingSelectionLink ? t("recipes.selection.sendingLink") : t("recipes.selection.sendLink")}
                </button>
                <button type="button" className="btn" onClick={exitSelectionMode}>
                  {t("recipes.selection.cancel")}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "-4px", marginBottom: "12px" }}>
            <button type="button" className="recipes-nav-back-link" onClick={enterSelectionMode}>
              {t("recipes.selection.enter")}
            </button>
          </div>
        )
      ) : null}
      {viewMode === "mine" && showPdfProPrompt ? (
        <div className="card" style={{ marginTop: "-4px", marginBottom: "12px", padding: "10px 12px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted">🔒 {t("subscription.availableInPro")}</span>
            <button type="button" className="btn btn-primary" onClick={() => router.push("/auth")}>
              {t("subscription.goToPro")}
            </button>
          </div>
        </div>
      ) : null}

      {viewMode === "mine" && personalTagFilterOptions.length > 0 ? (
        <div className="recipes-filters-chips" style={{ marginTop: "-4px", marginBottom: "12px" }}>
          <span className="muted" style={{ alignSelf: "center" }}>{t("recipes.personalTags.filterLabel")}</span>
          {personalTagFilterOptions.map((item) => {
            const active = selectedPersonalTagFilters.some(
              (tag) => normalizePersonalTagKey(tag) === normalizePersonalTagKey(item.value)
            );
            return (
              <button
                key={item.value}
                type="button"
                className={`btn ${active ? "btn-primary" : ""}`.trim()}
                onClick={() => {
                  setSelectedPersonalTagFilters((prev) => {
                    const key = normalizePersonalTagKey(item.value);
                    const exists = prev.some((tag) => normalizePersonalTagKey(tag) === key);
                    if (exists) return prev.filter((tag) => normalizePersonalTagKey(tag) !== key);
                    return [...prev, item.value];
                  });
                }}
              >
                {item.value} ({item.count})
              </button>
            );
          })}
        </div>
      ) : null}

      {hasAnyRecipes ? (
        <>
          <div className="recipes-filters-quick">
            <input
              className="input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("recipes.filters.searchPlaceholder")}
            />
            <div className="recipes-language-filter">
              <span className="recipes-language-filter__label">
                {t("recipes.filters.languageFilter.label")}
              </span>
              <div className="recipes-language-filter__options">
                {LANGUAGE_FILTER_OPTIONS.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={[
                      "recipes-language-filter__option",
                      languageFilterMode === mode && "recipes-language-filter__option--active",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-pressed={languageFilterMode === mode}
                    onClick={() => setLanguageFilterMode(mode)}
                  >
                    <span>{t(`recipes.filters.languageFilter.${mode}`)}</span>
                  </button>
                ))}
              </div>
            </div>
            <select
              className="input"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{ maxWidth: "250px" }}
            >
              <option value="newest">{t("recipes.sort.newest")}</option>
              <option value="oldest">{t("recipes.sort.oldest")}</option>
              <option value="title_asc">{t("recipes.sort.titleAsc")}</option>
              <option value="title_desc">{t("recipes.sort.titleDesc")}</option>
              {canUseAdvancedFilters ? (
                <>
                  <option value="often_cooked">{t("recipes.sort.oftenCooked")}</option>
                  <option value="rarely_cooked">{t("recipes.sort.rarelyCooked")}</option>
                </>
              ) : null}
            </select>
            <button
              type="button"
              className={`btn ${showAdvancedFilters ? "btn-primary" : ""}`}
              onClick={() => {
                if (!canUseAdvancedFilters) {
                  setActionMessage(t("subscription.locks.advancedFilters"));
                  return;
                }
                setShowAdvancedFilters((prev) => !prev);
              }}
            >
              {t("recipes.filters.button")}{effectiveSelectedTags.length > 0 ? ` (${effectiveSelectedTags.length})` : ""}
            </button>
          </div>

          {canUseAdvancedFilters ? (
            <div className="recipes-filters-chips">
              <button
                type="button"
                className={`btn ${onlyWithPhoto ? "btn-primary" : ""}`}
                onClick={() => {
                  setOnlyWithPhoto((prev) => !prev);
                }}
              >
                {t("recipes.filters.withPhoto")}
              </button>
              {viewMode === "mine" ? (
                <button
                  type="button"
                  className={`btn ${onlyWithNotes ? "btn-primary" : ""}`}
                  onClick={() => setOnlyWithNotes((prev) => !prev)}
                >
                  {t("recipes.filters.withNotes")}
                </button>
              ) : null}
              <button
                type="button"
                className={`btn ${onlyWithActiveProducts ? "btn-primary" : ""}`}
                onClick={() => setOnlyWithActiveProducts((prev) => !prev)}
                disabled={activeProductNames.length === 0}
                title={
                  activeProductNames.length === 0
                    ? t("recipes.filters.activeProductsDisabled")
                    : t("recipes.filters.activeProductsTooltip")
                }
              >
                {t("recipes.filters.onlyWithActiveProducts")}
              </button>
              <button
                type="button"
                className={`btn ${onlyFromPantry ? "btn-primary" : ""}`}
                onClick={() => setOnlyFromPantry((prev) => !prev)}
                disabled={pantryProductNames.length === 0}
                title={
                  pantryProductNames.length === 0
                    ? t("recipes.filters.pantryEmpty")
                    : t("recipes.filters.onlyFromPantryTooltip")
                }
              >
                {t("recipes.filters.onlyFromPantry")}
              </button>
              {hasActiveFilters && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setOnlyWithPhoto(false);
                    setOnlyWithNotes(false);
                    setOnlyWithActiveProducts(false);
                    setOnlyFromPantry(false);
                    setSelectedTags([]);
                    setSelectedPersonalTagFilters([]);
                    setSearchQuery("");
                  }}
                >
                  {t("recipes.filters.resetAll")}
                </button>
              )}
            </div>
          ) : null}

          {canUseAdvancedFilters && showAdvancedFilters ? (
            <div className="recipes-filters-advanced">
              <div style={{ marginBottom: "8px", fontWeight: 600 }}>{t("recipes.filters.tags")}</div>
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
                {selectedTags.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setSelectedTags([])}
                  >
                    {t("recipes.filters.resetTags")}
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {actionMessage && (
        <p className="muted" style={{ marginBottom: "14px" }}>
          {actionMessage}
        </p>
      )}

      {showGuestRegisterReminder && (
        <div className="card" style={{ marginBottom: "14px", padding: "12px 14px", borderRadius: "10px" }}>
          <img
            src="/mascot/pages/auth.png"
            alt=""
            aria-hidden="true"
            style={{ width: "74px", height: "74px", objectFit: "contain", marginBottom: "6px" }}
          />
          <p style={{ margin: 0, fontWeight: 700 }}>
            {t("recipes.guestReminder.text")}
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "6px",
              marginTop: "8px",
            }}
          >
            <button type="button" className="btn btn-primary" onClick={() => router.push("/auth")}>
              {t("recipes.guestReminder.createAccount")}
            </button>
            <button type="button" className="menu-first-onboarding__skip" onClick={handleDismissGuestRegisterReminder}>
              {t("recipes.guestReminder.later")}
            </button>
          </div>
        </div>
      )}

      {showFirstRecipeSuccess && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("recipes.success.firstAddedAria")}
          className="menu-first-onboarding"
        >
          <div className="menu-first-onboarding__card" style={{ width: "min(520px, 100%)" }}>
            <img
              src="/mascot/pages/recipes-success.png"
              alt=""
              aria-hidden="true"
              className="menu-first-onboarding__mascot"
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = "/mascot/pages/recipes.png";
              }}
            />
            <h2 className="menu-first-onboarding__title">{t("recipes.success.title")}</h2>
            <p className="menu-first-onboarding__text">{t("recipes.success.description")}</p>
            <div className="menu-first-onboarding__actions">
              <button className="btn btn-primary" onClick={handleAddFirstRecipeToMenu}>
                {t("recipes.success.addToMenu")}
              </button>
              <button type="button" className="menu-first-onboarding__skip" onClick={handleDismissFirstRecipeSuccess}>
                {t("recipes.guestReminder.later")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showBlockingLoading ? (
        <div className="empty-state">
          <div className="empty-state__title">{t("recipes.loading")}</div>
        </div>
      ) : isEmptyState ? (
        showFirstRecipePrompt ? null : (
          <div className="empty-state">
            <div className="empty-state__title">{t("recipes.empty.title")}</div>
            <div className="empty-state__description">{t("recipes.empty.description")}</div>
            <div style={{ marginTop: "14px", display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                onClick={isGuest ? () => router.push("/auth") : handleCreateRecipe}
              >
                {isGuest ? t("recipes.guestReminder.createAccount") : t("recipes.empty.addFirst")}
              </button>
              {viewMode === "mine" ? (
                <button className="btn" onClick={() => setViewMode("public")}>
                  {t("recipes.onboarding.chooseReady")}
                </button>
              ) : !isGuest ? (
                <button className="btn" onClick={() => setViewMode("mine")}>
                  {t("recipes.actions.goToMine")}
                </button>
              ) : (
                <button className="btn" onClick={() => router.push("/auth")}>
                  {t("recipes.guestReminder.createAccount")}
                </button>
              )}
            </div>
          </div>
        )
      ) : isFilteredEmpty ? (
        <div className="empty-state">
          <div className="empty-state__title">{t("recipes.emptyFiltered.title")}</div>
          <div className="empty-state__description">{t("recipes.emptyFiltered.description")}</div>
        {hasActiveFilters ? (
            <div style={{ marginTop: "14px" }}>
              <button
                className="btn"
                onClick={() => {
                  setOnlyWithPhoto(false);
                  setOnlyWithNotes(false);
                  setOnlyWithActiveProducts(false);
                  setOnlyFromPantry(false);
                  setSelectedTags([]);
                  setSelectedPersonalTagFilters([]);
                  setSearchQuery("");
                }}
              >
                {t("recipes.filters.resetAll")}
              </button>
            </div>
        ) : null}
          {viewMode === "mine" && hasAnyRecipes ? (
            <div className="recipes-clear-link-wrapper">
              <button
                type="button"
                className="recipes-clear-link"
                onClick={handleClearAllRecipes}
              >
                {t("recipes.actions.clearMine")}
              </button>
            </div>
          ) : null}
      </div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {filteredRecipes.map((recipe) => {
            const localized = getRecipeLocalizedContent(recipe, uiRecipeLanguage);
            const recipeCardTitle = localized.title || recipe.title || t("menu.fallback.recipeTitle");
            const recipeCardShortDescription = localized.shortDescription || "";
            const recipeCardDescription = localized.description || "";
            const isOwner = currentUserId && recipe.ownerId === currentUserId;
            const isMineCard = viewMode === "mine";
            const isSelectedForExport = Boolean(selectedRecipeIds[recipe.id]);
            const cardImage = resolveRecipeCardImage(recipe);
            const duplicateExists =
              viewMode === "public" &&
              existingMineTitleSet.has(normalizeRecipeTitle(getRecipeCanonicalTitle(recipe)));
            const isPublicSourceRecipe = viewMode === "public" && !isOwner;
            const isGuestPublicViewer = isPublicSourceRecipe && !currentUserId;
            const recipeTitleKey = normalizeRecipeTitle(getRecipeCanonicalTitle(recipe));
            const existingMineRecipeId = isPublicSourceRecipe ? existingMineByTitle.get(recipeTitleKey) || null : null;
            const openTargetId = duplicateExists && existingMineRecipeId ? existingMineRecipeId : recipe.id;
            const addedNow = Boolean(justAddedRecipeTitles[recipeTitleKey]);
            const addDone = duplicateExists || addedNow;
            const isAdding = pendingCopyRecipeId === recipe.id;
            const isPublicRecipe = recipe.visibility === "public";
            const authorUserId = String(recipe.authorId || recipe.ownerId || "").trim();
            const authorProfile = isPublicRecipe ? publicAuthorProfiles[authorUserId] : undefined;
            const authorName =
              (authorProfile?.displayName || "").trim() ||
              (authorUserId === "system" ? t("recipes.card.planottoAuthor") : t("recipes.card.authorUnknown"));
            const canOpenAuthorPage = isPublicRecipe && (authorUserId === "system" || isUuidLike(authorUserId));
            const timesCooked = Number(
              (recipe as RecipeModel & { timesCooked?: number }).timesCooked || 0
            );
            const sourceLabel = isPublicSourceRecipe
              ? addDone
                ? t("recipes.card.sourcePublicAdded")
                : t("recipes.card.sourcePublic")
              : t("recipes.card.sourceMine");
            const matchMeta = recipeActiveMatchMap.get(recipe.id) || { matchCount: 0, topMatches: [], extraMatches: 0 };
            const preferenceMeta = recipePreferenceMatchMap.get(recipe.id) || {
              allergyCount: 0,
              dislikeCount: 0,
              allergyMatches: [],
              dislikeMatches: [],
              topDislikes: [],
              extraDislikes: 0,
            };
            const pantryMeta = recipePantryCoverageMap.get(recipe.id) || {
              totalIngredients: 0,
              matchedIngredients: 0,
              isFullyCovered: false,
            };
            const pantryCoverageText =
              pantryMeta.totalIngredients > 0
                ? `${pantryMeta.matchedIngredients}/${pantryMeta.totalIngredients}`
                : "";
            const matchTooltip =
              matchMeta.matchCount > 0
                ? t("recipes.card.matchTooltip", {
                    names: matchMeta.topMatches.join(", "),
                    extra: matchMeta.extraMatches > 0 ? ` (+${matchMeta.extraMatches})` : "",
                  })
                : "";
            const dislikeTooltip =
              preferenceMeta.dislikeCount > 0
                ? t("recipes.card.dislikeTooltip", {
                    names: preferenceMeta.topDislikes.join(", "),
                    extra: preferenceMeta.extraDislikes > 0 ? ` (+${preferenceMeta.extraDislikes})` : "",
                  })
                : "";
            const mainActionLabel = isPublicSourceRecipe
              ? isGuestPublicViewer
                ? t("recipes.card.open")
                : addDone
                  ? t("recipes.card.alreadyMine")
                  : isAdding
                    ? t("recipes.card.adding")
                    : t("recipes.card.addToMine")
              : t("recipes.card.open");
            const mainActionClassName = `btn ${
              isPublicSourceRecipe && !isGuestPublicViewer
                ? addDone
                  ? "recipes-card__add-btn--disabled"
                  : "btn-primary"
                : ""
            }`.trim();
            const menuTargetRecipeId = !isPublicSourceRecipe
              ? recipe.id
              : isGuestPublicViewer
                ? null
              : addDone
                ? existingMineRecipeId
                : null;
            const canQuickAddToMenu = profileGoal === "menu" && Boolean(menuTargetRecipeId);
            const handleMainAction = () => {
              if (isPublicSourceRecipe) {
                if (isGuestPublicViewer) {
                  router.push(`/recipes/${recipe.id}`);
                  return;
                }
                if (addDone) {
                  return;
                }
                handleCopyToMine(recipe.id);
                return;
              }
              router.push(`/recipes/${recipe.id}`);
            };
            return (
              <div
                key={recipe.id}
                className="card"
                style={{
                  textAlign: "left",
                  background: isPublicSourceRecipe && addDone
                    ? "color-mix(in srgb, var(--background-primary) 84%, var(--accent-primary) 16%)"
                    : undefined,
                  borderColor: isPublicSourceRecipe && addDone ? "rgba(135, 152, 116, 0.45)" : undefined,
                }}
              >
                <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
                  {cardImage ? (
                    <img
                      src={cardImage}
                      alt={recipeCardTitle}
                      style={{
                        width: "84px",
                        height: "84px",
                        borderRadius: "10px",
                        objectFit: "cover",
                        flexShrink: 0,
                      }}
                    />
                  ) : null}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <h3 style={{ margin: 0 }}>{recipeCardTitle}</h3>
                        <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          <span>{sourceLabel}</span>
                          {isPublicRecipe ? (
                            <span>
                              {t("recipes.card.authorLabel")}:{" "}
                              {canOpenAuthorPage ? (
                                <Link
                                  href={`/authors/${encodeURIComponent(authorUserId || "system")}`}
                                  className="recipes-card__author-link"
                                >
                                  {authorName}
                                </Link>
                              ) : (
                                <span>{authorName}</span>
                              )}
                            </span>
                          ) : null}
                          {viewMode === "mine" && recipe.visibility !== "private" ? (
                            (() => {
                              const meta = VISIBILITY_BADGE_META[recipe.visibility as Exclude<RecipeVisibility, "private">];
                              return (
                                <span
                                  title={t(meta.titleKey)}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    border: "1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--border-default) 55%)",
                                    borderRadius: "999px",
                                    width: "24px",
                                    height: "24px",
                                    color: "var(--text-secondary)",
                                    fontSize: "13px",
                                    background: "color-mix(in srgb, var(--accent-primary) 10%, var(--background-primary) 90%)",
                                  }}
                                >
                                  {meta.emoji}
                                </span>
                              );
                            })()
                          ) : null}
                          {pantryCoverageText ? (
                            <span
                              title={t("recipes.card.pantryCoverageTitle", {
                                matched: pantryMeta.matchedIngredients,
                                total: pantryMeta.totalIngredients,
                              })}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                border: "1px solid var(--border-default)",
                                borderRadius: "999px",
                                padding: "1px 7px",
                                color: "var(--text-secondary)",
                                fontSize: "11px",
                                background: "var(--background-secondary)",
                              }}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path d="M3 10.5L12 3l9 7.5V21H3V10.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                <path d="M9 21v-6h6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                              </svg>
                              <span>{pantryCoverageText}</span>
                            </span>
                          ) : null}
                          {matchMeta.matchCount > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setOpenActiveMatchesRecipeId((prev) => (prev === recipe.id ? null : recipe.id))
                              }
                              title={matchTooltip}
                              style={{
                                border: "1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--border-default) 55%)",
                                background: "color-mix(in srgb, var(--accent-primary) 14%, var(--background-primary) 86%)",
                                color: "var(--text-primary)",
                                borderRadius: "999px",
                                fontSize: "11px",
                                padding: "1px 7px",
                                lineHeight: 1.4,
                                cursor: "pointer",
                              }}
                            >
                              {t("recipes.card.matches", { count: matchMeta.matchCount })}
                            </button>
                          ) : null}
                          {preferenceMeta.dislikeCount > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setOpenDislikeRecipeId((prev) => (prev === recipe.id ? null : recipe.id))
                              }
                              title={dislikeTooltip}
                              style={{
                                border: "1px solid color-mix(in srgb, var(--border-default) 82%, #8e8e8e 18%)",
                                background: "color-mix(in srgb, var(--background-secondary) 88%, #8e8e8e 12%)",
                                color: "var(--text-secondary)",
                                borderRadius: "999px",
                                fontSize: "11px",
                                padding: "1px 7px",
                                lineHeight: 1.4,
                                cursor: "pointer",
                              }}
                            >
                              {t("recipes.card.dislikeBadge")}
                            </button>
                          ) : null}
                        </div>
                        {openActiveMatchesRecipeId === recipe.id && matchTooltip ? (
                          <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
                            {matchTooltip}
                          </div>
                        ) : null}
                        {openDislikeRecipeId === recipe.id && dislikeTooltip ? (
                          <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
                            {t("recipes.card.dislikeHint")}
                          </div>
                        ) : null}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-end",
                          gap: "4px",
                          fontSize: "13px",
                          color: "var(--text-secondary)",
                          flexShrink: 0,
                        }}
                      >
                        <span>{t("recipes.card.servings", { count: recipe.servings || 2 })}</span>
                        {timesCooked > 0 ? (
                          <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                            {t("recipes.card.cookedTimes", { count: timesCooked })}
                          </span>
                        ) : null}
                      </div>
                      {isMineCard && isSelectionMode ? (
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "8px", fontSize: "12px", color: "var(--text-secondary)" }}>
                          <input
                            type="checkbox"
                            checked={isSelectedForExport}
                            onChange={(event) => {
                              toggleRecipeSelection(recipe.id, event.target.checked);
                            }}
                          />
                          {t("recipes.selection.itemLabel")}
                        </label>
                      ) : null}
                    </div>

                    {(() => {
                      const cardDescription =
                        recipeCardShortDescription || (looksLikeUrl(recipeCardDescription) ? "" : recipeCardDescription);
                      return cardDescription ? (
                        <p
                          style={{
                            margin: "8px 0 0 0",
                            color: "var(--text-secondary)",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {cardDescription}
                        </p>
                      ) : null;
                    })()}

                    {isMineCard ? (
                      <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
                        <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                          <strong>📝 {t("recipes.personalTags.noteLabel")}:</strong>{" "}
                          {recipe.notes?.trim() ? recipe.notes.trim() : t("recipes.personalTags.noteEmpty")}
                        </div>

                        <div>
                          <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "6px" }}>
                            <strong>🏷 {t("recipes.personalTags.myTagsLabel")}:</strong>
                            {" "}
                            <span>
                              ({(recipe.personalTags || []).length}/{PERSONAL_TAG_MAX_COUNT})
                            </span>
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                            {(recipe.personalTags || []).map((tag, index, list) => (
                              <span
                                key={`${recipe.id}-${tag}`}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  border: "1px solid var(--border-default)",
                                  borderRadius: "999px",
                                  padding: "2px 8px",
                                  fontSize: "12px",
                                  background: "var(--background-secondary)",
                                }}
                              >
                                {tag}
                                <button
                                  type="button"
                                  className="btn"
                                  style={{ padding: "0 4px", minHeight: "auto", lineHeight: 1 }}
                                  aria-label={t("recipes.personalTags.moveLeftAria", { tag })}
                                  onClick={() => {
                                    void handleMovePersonalTag(recipe, tag, "left");
                                  }}
                                  disabled={savingPersonalTagsRecipeId === recipe.id || index === 0}
                                >
                                  ‹
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  style={{ padding: "0 4px", minHeight: "auto", lineHeight: 1 }}
                                  aria-label={t("recipes.personalTags.moveRightAria", { tag })}
                                  onClick={() => {
                                    void handleMovePersonalTag(recipe, tag, "right");
                                  }}
                                  disabled={savingPersonalTagsRecipeId === recipe.id || index === list.length - 1}
                                >
                                  ›
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  style={{ padding: "0 4px", minHeight: "auto", lineHeight: 1 }}
                                  aria-label={t("recipes.personalTags.removeTagAria", { tag })}
                                  onClick={() => {
                                    void handleRemovePersonalTag(recipe, tag);
                                  }}
                                  disabled={savingPersonalTagsRecipeId === recipe.id}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            <button
                              type="button"
                              className="btn"
                              aria-label={t("recipes.personalTags.addTag")}
                              title={t("recipes.personalTags.addTag")}
                              style={{
                                minHeight: "24px",
                                lineHeight: 1.1,
                                borderRadius: "999px",
                                padding: "2px 9px",
                                fontSize: "14px",
                                fontWeight: 700,
                                color: showPersonalTagsHint ? "var(--accent-primary)" : "var(--text-secondary)",
                                borderColor: showPersonalTagsHint
                                  ? "color-mix(in srgb, var(--accent-primary) 58%, var(--border-default) 42%)"
                                  : "var(--border-default)",
                                background: "var(--background-primary)",
                              }}
                              onClick={() => {
                                setPersonalTagEditorRecipeId(recipe.id);
                                setPersonalTagDraft("");
                                markPersonalTagsHintSeen();
                              }}
                              disabled={savingPersonalTagsRecipeId === recipe.id}
                            >
                              +
                            </button>
                          </div>
                          {personalTagEditorRecipeId === recipe.id ? (
                            <div style={{ marginTop: "8px", display: "grid", gap: "6px" }}>
                              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                <input
                                  className="input"
                                  type="text"
                                  value={personalTagDraft}
                                  onChange={(event) => setPersonalTagDraft(event.target.value)}
                                  placeholder={t("recipes.personalTags.addPlaceholder")}
                                  style={{ maxWidth: "240px" }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                    event.preventDefault();
                                    void handleSavePersonalTag(recipe);
                                    }
                                  }}
                                />
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  onClick={() => {
                                    void handleSavePersonalTag(recipe);
                                  }}
                                  disabled={savingPersonalTagsRecipeId === recipe.id}
                                >
                                  {t("recipes.personalTags.addAction")}
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => {
                                    setPersonalTagEditorRecipeId(null);
                                    setPersonalTagDraft("");
                                  }}
                                >
                                  {t("recipes.personalTags.cancel")}
                                </button>
                              </div>
                              <div className="muted" style={{ marginTop: "2px", fontSize: "12px" }}>
                                {t("recipes.personalTags.bulkInputHint", {
                                  max: PERSONAL_TAG_MAX_COUNT,
                                  maxLength: PERSONAL_TAG_MAX_LENGTH,
                                })}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        className={mainActionClassName}
                        onClick={handleMainAction}
                        disabled={isPublicSourceRecipe && !isGuestPublicViewer && (isAdding || addDone)}
                      >
                        {mainActionLabel}
                      </button>
                      {isPublicSourceRecipe && !isGuestPublicViewer ? (
                        <button className="btn" onClick={() => router.push(`/recipes/${openTargetId}`)}>
                          {t("recipes.card.open")}
                        </button>
                      ) : null}
                      {isGuestPublicViewer ? (
                        <button className="btn" onClick={() => router.push("/auth")}>
                          🔒 {t("recipes.guestMode.addToMineLocked")}
                        </button>
                      ) : null}
                      {canQuickAddToMenu ? (
                        <button
                          className="btn"
                          onClick={() => openMenuWithRecipe(menuTargetRecipeId as string)}
                        >
                          {t("recipes.success.addToMenu")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>

      {confirmDialog}

      {addToMenuPromptRecipeId ? (
        <div
          className="recipes-add-to-menu-banner recipes-add-to-menu-banner--dismissable"
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            className="recipes-add-to-menu-banner__close"
            onClick={handleDismissAddedRecipeMenu}
            aria-label={t("recipes.addToMenuPrompt.closeAria")}
            title={t("recipes.addToMenuPrompt.closeAria")}
          >
            ×
          </button>
          <span className="recipes-add-to-menu-banner__text">{t("recipes.addToMenuPrompt.title")}</span>
          <div className="recipes-add-to-menu-banner__actions">
            <button type="button" className="btn btn-primary" onClick={handleConfirmAddedRecipeMenu}>
              {t("recipes.addToMenuPrompt.confirm")}
            </button>
            <button type="button" className="btn" onClick={handleDismissAddedRecipeMenu}>
              {t("recipes.addToMenuPrompt.later")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function RecipesPage() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <section className="card">
          <h1 className="h1">{t("recipes.loadingList")}</h1>
        </section>
      }
    >
      <RecipesPageContent />
    </Suspense>
  );
}




