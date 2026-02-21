"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import {
  createRecipe,
  deleteRecipe,
  deleteAllMyRecipes,
  importLocalRecipesIfNeeded,
  listSeedTemplateRecipes,
  listMyRecipes,
  loadLocalRecipes,
  removeRecipeFromLocalCache,
  syncRecipesToLocalCache,
  upsertRecipeInLocalCache,
  type RecipeModel,
} from "../lib/recipesSupabase";
import { getSupabaseClient, isSupabaseConfigured } from "../lib/supabaseClient";
import { RECIPE_TAGS } from "../lib/recipeTags";

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

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(value.trim());
}

function normalizeRecipeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isSeedTemplateId(recipeId: string | null | undefined): boolean {
  return String(recipeId || "").trim().toLowerCase().startsWith("seed-");
}

function resolveRecipeCardImage(recipe: RecipeModel): string | null {
  const normalizedTitle = normalizeRecipeTitle(recipe.title || "");
  const matched = Object.entries(TEMPLATE_IMAGE_FALLBACKS).find(
    ([title]) => normalizeRecipeTitle(title) === normalizedTitle
  );
  // For seed starter recipes, always prefer local bundled images.
  if (matched && recipe.type === "template") return matched[1];
  // Legacy copied "Суп из чечевицы" can contain a broken cached image URL.
  if (matched && normalizeRecipeTitle("Суп из чечевицы") === normalizedTitle) return matched[1];
  const direct = recipe.image?.trim();
  if (direct) return direct;
  if (matched) return matched[1];
  return null;
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

  if (/(завтрак|утрен|каша|омлет|олад|блин)/u.test(text)) return "Завтрак";
  if (/(обед|суп)/u.test(text)) return "Обед";
  if (/(ужин|вечер)/u.test(text)) return "Ужин";
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
  const router = useRouter();
  const searchParams = useSearchParams();

  const [recipes, setRecipes] = useState<RecipeModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [onlyWithPhoto, setOnlyWithPhoto] = useState(false);
  const [onlyWithoutPhoto, setOnlyWithoutPhoto] = useState(false);
  const [onlyWithNotes, setOnlyWithNotes] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("mine");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string | null>(null);
  const [currentUserAvatar, setCurrentUserAvatar] = useState<string | null>(null);
  const [currentUserFrame, setCurrentUserFrame] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [pendingCopyRecipeId, setPendingCopyRecipeId] = useState<string | null>(null);
  const [mineSyncVersion, setMineSyncVersion] = useState(0);
  const [justAddedRecipeTitles, setJustAddedRecipeTitles] = useState<Record<string, boolean>>({});
  const [addedToastMessage, setAddedToastMessage] = useState<string | null>(null);
  const [showFirstRecipeSuccess, setShowFirstRecipeSuccess] = useState(false);
  const [isFirstRecipeFlow, setIsFirstRecipeFlow] = useState(false);
  const [firstCopiedRecipeId, setFirstCopiedRecipeId] = useState<string | null>(null);
  const [showGuestRegisterReminder, setShowGuestRegisterReminder] = useState(false);

  const importedForUser = useRef<string | null>(null);
  const addedToastTimerRef = useRef<number | null>(null);

  const refreshRecipes = async (mode: ViewMode, userId: string | null): Promise<void> => {
    setIsLoading(true);

    try {
      if (!isSupabaseConfigured()) {
        setRecipes(mode === "public" ? listSeedTemplateRecipes() : loadLocalRecipes());
        return;
      }

      if (mode === "mine") {
        if (!userId) {
          setRecipes(loadLocalRecipes());
          return;
        }

        if (importedForUser.current !== userId) {
          await importLocalRecipesIfNeeded(userId);
          importedForUser.current = userId;
        }

        const mine = await listMyRecipes(userId);
        setRecipes(mine);
        syncRecipesToLocalCache(mine);
        return;
      }

      setRecipes(listSeedTemplateRecipes());
    } catch (requestError) {
      console.error("[recipes] failed to load recipes", requestError);
      setRecipes(mode === "public" ? listSeedTemplateRecipes() : []);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isSupabaseConfigured()) {
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
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUserId(session?.user?.id || null);
      setCurrentUserEmail(session?.user?.email || null);
      setCurrentUserName(resolveUserName(session?.user));
      setCurrentUserAvatar(resolveUserAvatar(session?.user));
      setCurrentUserFrame(resolveUserFrame(session?.user));
      importedForUser.current = null;
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (addedToastTimerRef.current !== null) {
        window.clearTimeout(addedToastTimerRef.current);
      }
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

  const filteredRecipes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const getTimesCooked = (item: RecipeModel): number => {
      const value = (item as RecipeModel & { timesCooked?: number }).timesCooked;
      return Number.isFinite(value) ? Number(value) : 0;
    };

    const filtered = recipes.filter((item) => {
      const tags = item.tags || item.categories || [];
      const passesTags = selectedTags.every((tag) => tags.includes(tag));
      if (!passesTags) return false;
      if (onlyWithPhoto && !item.image?.trim()) return false;
      if (onlyWithoutPhoto && item.image?.trim()) return false;
      if (onlyWithNotes && !item.notes?.trim()) return false;
      if (!query) return true;

      const title = (item.title || "").toLowerCase();
      const shortDescription = (item.shortDescription || "").toLowerCase();
      const ingredientsText = (item.ingredients || [])
        .map((ingredient) => (ingredient.name || "").toLowerCase())
        .join(" ");

      return (
        title.includes(query) ||
        shortDescription.includes(query) ||
        ingredientsText.includes(query)
      );
    });

    filtered.sort((a, b) => {
      const aTitle = (a.title || "").toLowerCase();
      const bTitle = (b.title || "").toLowerCase();
      const aCreated = Date.parse(a.createdAt || "") || 0;
      const bCreated = Date.parse(b.createdAt || "") || 0;
      const aCooked = getTimesCooked(a);
      const bCooked = getTimesCooked(b);

      switch (sortBy) {
        case "oldest":
          return aCreated - bCreated;
        case "title_asc":
          return aTitle.localeCompare(bTitle, "ru");
        case "title_desc":
          return bTitle.localeCompare(aTitle, "ru");
        case "often_cooked":
          return bCooked - aCooked;
        case "rarely_cooked":
          return aCooked - bCooked;
        case "newest":
        default:
          return bCreated - aCreated;
      }
    });

    return filtered;
  }, [
    onlyWithNotes,
    onlyWithPhoto,
    onlyWithoutPhoto,
    recipes,
    searchQuery,
    selectedTags,
    sortBy,
  ]);

  const existingMineTitleSet = useMemo(() => {
    if (typeof window === "undefined") return new Set<string>();

    const source = (viewMode === "mine" ? recipes : loadLocalRecipes()).filter(
      (item) => !isSeedTemplateId(item.id)
    );
    return new Set(
      source
        .map((item) => normalizeRecipeTitle(item.title || ""))
        .filter(Boolean)
    );
  }, [mineSyncVersion, recipes, viewMode]);

  const existingMineByTitle = useMemo(() => {
    if (typeof window === "undefined") return new Map<string, string>();
    const source = loadLocalRecipes().filter((item) => !isSeedTemplateId(item.id));
    const map = new Map<string, string>();
    source.forEach((item) => {
      const key = normalizeRecipeTitle(item.title || "");
      if (!key || !item.id || map.has(key)) return;
      map.set(key, item.id);
    });
    return map;
  }, [mineSyncVersion, recipes, viewMode]);

  const showAddedFeedback = (title: string, duplicate = false) => {
    const key = normalizeRecipeTitle(title);
    if (key) {
      setJustAddedRecipeTitles((prev) => ({ ...prev, [key]: true }));
    }
    setMineSyncVersion((prev) => prev + 1);
    setAddedToastMessage(duplicate ? "Рецепт уже был в моих рецептах." : "Рецепт добавлен в мои рецепты.");
    if (addedToastTimerRef.current !== null) {
      window.clearTimeout(addedToastTimerRef.current);
    }
    addedToastTimerRef.current = window.setTimeout(() => {
      setAddedToastMessage(null);
      addedToastTimerRef.current = null;
    }, 3500);
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

    const recipeFromState = recipes.find((item) => item.id === firstCopiedRecipeId) || null;
    const recipeForMenu = recipeFromState || findRecipeInLocalCacheById(firstCopiedRecipeId);
    const params = new URLSearchParams({ recipe: firstCopiedRecipeId });

    const recipeTitle = recipeForMenu?.title?.trim();
    if (recipeTitle) {
      params.set("title", recipeTitle);
    }
    params.set("meal", inferMealFromRecipeForMenu(recipeForMenu));

    handleDismissFirstRecipeSuccess();
    router.push("/menu?" + params.toString());
  };

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

  const handleCopyToMine = async (recipeId: string) => {
    const source = recipes.find((item) => item.id === recipeId);
    if (!source) return;
    setPendingCopyRecipeId(recipeId);

    try {
      const inFirstRecipeFlow =
        isFirstRecipeFlow ||
        (typeof window !== "undefined" &&
          (localStorage.getItem(RECIPES_FIRST_FLOW_KEY) === "1" ||
            localStorage.getItem(FIRST_RECIPE_CREATE_FLOW_KEY) === "1"));

      if (!currentUserId) {
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
        if (inFirstRecipeFlow) {
          localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
          localStorage.removeItem(FIRST_RECIPE_CREATE_FLOW_KEY);
          setIsFirstRecipeFlow(false);
          setShowFirstRecipeSuccess(true);
          setFirstCopiedRecipeId(localCopy.id);
          setActionMessage("");
          setViewMode("public");
        } else {
          setActionMessage("");
          showAddedFeedback(source.title || "", false);
        }
        return;
      }

      const copied = await createRecipe(currentUserId, {
        title: source.title || "Рецепт",
        shortDescription: source.shortDescription || "",
        description: source.description || "",
        instructions: source.instructions || source.description || "",
        ingredients: (source.ingredients || []).map((item) => ({
          name: item.name || "",
          amount: Number(item.amount || 0),
          unit: item.unit || "шт",
        })),
        notes: source.notes || "",
        servings: source.servings && source.servings > 0 ? source.servings : 2,
        image: source.image || "",
        visibility: "private",
        categories: source.tags || source.categories || [],
        tags: source.tags || source.categories || [],
      });
      upsertRecipeInLocalCache(copied);
      if (inFirstRecipeFlow) {
        localStorage.removeItem(RECIPES_FIRST_FLOW_KEY);
        localStorage.removeItem(FIRST_RECIPE_CREATE_FLOW_KEY);
        setIsFirstRecipeFlow(false);
        setShowFirstRecipeSuccess(true);
        setFirstCopiedRecipeId(copied.id);
        setActionMessage("");
        setViewMode("public");
      } else {
        setActionMessage("");
        showAddedFeedback(source.title || "", false);
      }
    } catch (copyError) {
      const text = copyError instanceof Error ? copyError.message : "Не удалось скопировать рецепт.";
      setActionMessage(text);
    } finally {
      setPendingCopyRecipeId((prev) => (prev === recipeId ? null : prev));
    }
  };

  const handleClearAllRecipes = async () => {
    const ok = confirm("Удалить все ваши рецепты? Локальные черновики тоже будут очищены.");
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

      if (isSupabaseConfigured() && currentUserId) {
        await deleteAllMyRecipes(currentUserId);
      }

      await refreshRecipes(viewMode, currentUserId);
      setActionMessage("Рецепты очищены. Можно загружать новые для теста.");
    } catch (clearError) {
      const text =
        clearError instanceof Error
          ? clearError.message
          : typeof clearError === "object" && clearError && "message" in clearError
            ? String((clearError as { message?: unknown }).message || "Не удалось очистить рецепты.")
            : "Не удалось очистить рецепты.";
      setActionMessage(text);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteRecipe = async (recipe: RecipeModel) => {
    const ok = confirm(`Удалить рецепт "${recipe.title}"?`);
    if (!ok) return;

    try {
      const canDeleteInSupabase =
        isSupabaseConfigured() && !!currentUserId && !!recipe.ownerId && recipe.ownerId === currentUserId;

      if (canDeleteInSupabase) {
        await deleteRecipe(currentUserId as string, recipe.id);
      }

      removeRecipeFromLocalCache(recipe.id);
      setRecipes((prev) => prev.filter((item) => item.id !== recipe.id));
      setActionMessage("Рецепт удален.");
    } catch (deleteError) {
      const text = deleteError instanceof Error ? deleteError.message : "Не удалось удалить рецепт.";
      setActionMessage(text);
    }
  };

  const accountNameView = currentUserName || "Гость";
  const accountEmailView = currentUserEmail || "Нажмите, чтобы войти";
  const accountInitial = accountNameView.charAt(0).toUpperCase() || "Г";
  const hasAnyRecipes = recipes.length > 0;
  const hasActiveFilters =
    selectedTags.length > 0 ||
    onlyWithPhoto ||
    onlyWithoutPhoto ||
    onlyWithNotes ||
    searchQuery.trim().length > 0;
  const isEmptyState = !isLoading && !hasAnyRecipes;
  const isFilteredEmpty = !isLoading && hasAnyRecipes && filteredRecipes.length === 0;
  const showFirstRecipePrompt = isFirstRecipeFlow && !showFirstRecipeSuccess;

  const handleDismissGuestRegisterReminder = () => {
    setShowGuestRegisterReminder(false);
    if (typeof window !== "undefined") {
      localStorage.setItem(GUEST_RECIPES_REMINDER_DISMISSED_KEY, "1");
    }
  };

  return (
    <>
      {showFirstRecipePrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Первый рецепт"
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
            <h2 className="menu-first-onboarding__title">Выбери рецепт для старта</h2>
            <p className="menu-first-onboarding__text">
              Чтобы составить меню, добавьте один рецепт.
            </p>
            <div className="menu-first-onboarding__actions">
              <button type="button" className="btn btn-primary" onClick={handleChooseReadyRecipe}>
                Выбрать из готовых рецептов
              </button>
              <button
                type="button"
                onClick={handleCreateFirstRecipe}
                className="menu-first-onboarding__skip"
              >
                Добавить свой рецепт
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: "20px", maxWidth: "920px", margin: "0 auto" }}>
      <div className="recipes-topbar">
        <div className="recipes-topbar__actions">
          <button className="btn" onClick={() => router.push("/menu")}>
            ← Назад к меню
          </button>
          <button className="btn btn-add" onClick={handleCreateRecipe}>
            + Добавить рецепт
          </button>
          {viewMode === "mine" && hasAnyRecipes ? (
            <button className="btn btn-danger" onClick={handleClearAllRecipes}>
              Очистить мои рецепты
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
                alt="Аватар"
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
                alt="Рамка"
                className="recipes-account-chip__avatar-frame"
              />
            ) : null}
          </span>
          <span className="recipes-account-chip__content">
            <span className="recipes-account-chip__meta">
              {currentUserEmail ? "Аккаунт" : "Авторизация"}
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
        Рецепты
      </h1>
      <p className="muted" style={{ marginTop: "-10px", marginBottom: "14px" }}>
        {viewMode === "public"
          ? "Примеры для старта: выберите рецепт и добавьте копию в свою библиотеку."
          : "Твои рецепты: храни, редактируй и используй для планирования меню."}
      </p>

      <div style={{ marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button
          type="button"
          className={`btn ${viewMode === "mine" ? "btn-primary" : ""}`}
          onClick={() => setViewMode("mine")}
        >
          Мои
        </button>
        <button
          type="button"
          className={`btn ${viewMode === "public" ? "btn-primary" : ""}`}
          onClick={() => setViewMode("public")}
        >
          Примеры для старта
        </button>
      </div>

      {hasAnyRecipes ? (
        <>
          <div className="recipes-filters-quick">
            <input
              className="input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по названию и ингредиентам"
            />
            <select
              className="input"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{ maxWidth: "250px" }}
            >
              <option value="newest">Новые</option>
              <option value="oldest">Старые</option>
              <option value="title_asc">По названию А-Я</option>
              <option value="title_desc">По названию Я-А</option>
              <option value="often_cooked">Часто готовлю</option>
              <option value="rarely_cooked">Редко готовлю</option>
            </select>
            <button
              type="button"
              className={`btn ${showAdvancedFilters ? "btn-primary" : ""}`}
              onClick={() => setShowAdvancedFilters((prev) => !prev)}
            >
              Фильтры{selectedTags.length > 0 ? ` (${selectedTags.length})` : ""}
            </button>
          </div>

          <div className="recipes-filters-chips">
            <button
              type="button"
              className={`btn ${onlyWithPhoto ? "btn-primary" : ""}`}
              onClick={() => {
                setOnlyWithPhoto((prev) => !prev);
                setOnlyWithoutPhoto(false);
              }}
            >
              С фото
            </button>
            <button
              type="button"
              className={`btn ${onlyWithoutPhoto ? "btn-primary" : ""}`}
              onClick={() => {
                setOnlyWithoutPhoto((prev) => !prev);
                setOnlyWithPhoto(false);
              }}
            >
              Без фото
            </button>
            <button
              type="button"
              className={`btn ${onlyWithNotes ? "btn-primary" : ""}`}
              onClick={() => setOnlyWithNotes((prev) => !prev)}
            >
              Есть заметки
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOnlyWithPhoto(false);
                  setOnlyWithoutPhoto(false);
                  setOnlyWithNotes(false);
                  setSelectedTags([]);
                  setSearchQuery("");
                }}
              >
                Сбросить всё
              </button>
            )}
          </div>

          {showAdvancedFilters && (
            <div className="recipes-filters-advanced">
              <div style={{ marginBottom: "8px", fontWeight: 600 }}>Теги</div>
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
                {selectedTags.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setSelectedTags([])}
                  >
                    Сбросить теги
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      ) : null}

      {actionMessage && (
        <p className="muted" style={{ marginBottom: "14px" }}>
          {actionMessage}
        </p>
      )}

      {addedToastMessage ? (
        <div className="card" style={{ marginBottom: "14px", padding: "10px 12px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{addedToastMessage}</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setViewMode("mine");
              setAddedToastMessage(null);
            }}
          >
            Перейти в мои рецепты
          </button>
        </div>
      ) : null}

      {showGuestRegisterReminder && (
        <div className="card" style={{ marginBottom: "14px", padding: "12px 14px", borderRadius: "10px" }}>
          <img
            src="/mascot/pages/auth.png"
            alt=""
            aria-hidden="true"
            style={{ width: "74px", height: "74px", objectFit: "contain", marginBottom: "6px" }}
          />
          <p style={{ margin: 0, fontWeight: 700 }}>
            Вы уже добавили несколько рецептов. Чтобы они не потерялись, создайте аккаунт.
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
              Создать аккаунт
            </button>
            <button type="button" className="menu-first-onboarding__skip" onClick={handleDismissGuestRegisterReminder}>
              Позже
            </button>
          </div>
        </div>
      )}

      {showFirstRecipeSuccess && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Первый рецепт добавлен"
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
            <h2 className="menu-first-onboarding__title">Отлично! Первый рецепт добавлен.</h2>
            <p className="menu-first-onboarding__text">Теперь используем его в меню.</p>
            <div className="menu-first-onboarding__actions">
              <button className="btn btn-primary" onClick={handleAddFirstRecipeToMenu}>
                Добавить в меню
              </button>
              <button type="button" className="menu-first-onboarding__skip" onClick={handleDismissFirstRecipeSuccess}>
                Позже
              </button>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="empty-state">
          <div className="empty-state__title">Загрузка...</div>
        </div>
      ) : isEmptyState ? (
        showFirstRecipePrompt ? null : (
          <div className="empty-state">
            <div className="empty-state__title">У тебя пока нет рецептов</div>
            <div className="empty-state__description">Это нормально для первого входа. Начни с первого рецепта.</div>
            <div style={{ marginTop: "14px", display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={handleCreateRecipe}>
                Добавить первый рецепт
              </button>
              {viewMode === "mine" ? (
                <button className="btn" onClick={() => setViewMode("public")}>
                  Выбрать из готовых рецептов
                </button>
              ) : (
                <button className="btn" onClick={() => setViewMode("mine")}>
                  Перейти в мои рецепты
                </button>
              )}
            </div>
          </div>
        )
      ) : isFilteredEmpty ? (
        <div className="empty-state">
          <div className="empty-state__title">Ничего не найдено</div>
          <div className="empty-state__description">Попробуйте убрать часть фильтров или изменить запрос.</div>
          {hasActiveFilters ? (
            <div style={{ marginTop: "14px" }}>
              <button
                className="btn"
                onClick={() => {
                  setOnlyWithPhoto(false);
                  setOnlyWithoutPhoto(false);
                  setOnlyWithNotes(false);
                  setSelectedTags([]);
                  setSearchQuery("");
                }}
              >
                Сбросить фильтры
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {filteredRecipes.map((recipe) => {
            const isOwner = currentUserId && recipe.ownerId === currentUserId;
            const cardImage = resolveRecipeCardImage(recipe);
            const duplicateExists =
              viewMode === "public" &&
              existingMineTitleSet.has(normalizeRecipeTitle(recipe.title || ""));
            const isPublicSourceRecipe = viewMode === "public" && !isOwner;
            const recipeTitleKey = normalizeRecipeTitle(recipe.title || "");
            const existingMineRecipeId = isPublicSourceRecipe ? existingMineByTitle.get(recipeTitleKey) || null : null;
            const openTargetId = duplicateExists && existingMineRecipeId ? existingMineRecipeId : recipe.id;
            const addedNow = Boolean(justAddedRecipeTitles[recipeTitleKey]);
            const addDone = duplicateExists || addedNow;
            const isAdding = pendingCopyRecipeId === recipe.id;
            const sourceLabel = isPublicSourceRecipe
              ? addDone
                ? "Из примеров • уже в моих рецептах"
                : "Из примеров"
              : "Мой рецепт";
            const mainActionLabel = isPublicSourceRecipe
              ? isAdding
                ? "Добавляю..."
                : addDone
                  ? "Уже в моих"
                : "Добавить в мои"
              : "Открыть";
            const mainActionClassName = `btn ${isPublicSourceRecipe && !addDone ? "btn-primary" : ""}`.trim();
            const handleMainAction = () => {
              if (isPublicSourceRecipe) {
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
                      alt={recipe.title}
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
                        <h3 style={{ margin: 0 }}>{recipe.title}</h3>
                        <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--text-tertiary)" }}>
                          {sourceLabel}
                        </div>
                      </div>
                      <span style={{ fontSize: "13px", color: "var(--text-secondary)", flexShrink: 0 }}>
                        Порции: {recipe.servings || 2}
                      </span>
                    </div>

                    {(() => {
                      const fallbackDescription = recipe.description || "";
                      const cardDescription = recipe.shortDescription || (looksLikeUrl(fallbackDescription) ? "" : fallbackDescription);
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

                    <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        className={mainActionClassName}
                        onClick={handleMainAction}
                        disabled={isPublicSourceRecipe && isAdding}
                      >
                        {mainActionLabel}
                      </button>
                      {isPublicSourceRecipe ? (
                        <button className="btn" onClick={() => router.push(`/recipes/${openTargetId}`)}>
                          Открыть
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
    </>
  );
}

export default function RecipesPage() {
  return (
    <Suspense
      fallback={
        <section className="card">
          <h1 className="h1">Загрузка рецептов...</h1>
        </section>
      }
    >
      <RecipesPageContent />
    </Suspense>
  );
}




