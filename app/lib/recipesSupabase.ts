"use client";

import { getSupabaseClient } from "./supabaseClient";

export const RECIPES_STORAGE_KEY = "recipes";
const RECIPE_REPORTS_KEY = "recipeReports";
const RECIPES_CLOUD_FALLBACK_KEY = "planotto_recipes_cloud_v1";

export type RecipeVisibility = "private" | "public";

export interface Ingredient {
  name: string;
  amount: number;
  unit: string;
}

export interface RecipeModel {
  id: string;
  ownerId: string;
  type?: "user" | "template";
  isTemplate?: boolean;
  title: string;
  shortDescription?: string;
  description?: string;
  instructions?: string;
  ingredients: Ingredient[];
  notes?: string;
  servings: number;
  image?: string;
  categories: string[];
  tags: string[];
  visibility: RecipeVisibility;
  createdAt?: string;
  updatedAt?: string;
}

export interface RecipeUpsertInput {
  title: string;
  shortDescription?: string;
  description?: string;
  instructions?: string;
  ingredients: Ingredient[];
  notes?: string;
  servings?: number;
  image?: string;
  categories?: string[];
  tags?: string[];
  visibility?: RecipeVisibility;
}

interface RecipeRow {
  id: string;
  owner_id: string | null;
  title: string;
  short_description: string | null;
  description: string | null;
  instructions: string | null;
  ingredients: Ingredient[] | null;
  servings: number | null;
  image: string | null;
  categories: string[] | null;
  visibility: RecipeVisibility | null;
  created_at: string | null;
  updated_at: string | null;
}

interface RecipeNoteRow {
  recipe_id: string;
  notes: string | null;
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

type RecipeReportReason =
  | "Нарушение авторских прав"
  | "Чужой рецепт без указания источника"
  | "Другое";

interface RecipeReportRecord {
  recipeId: string;
  reason: RecipeReportReason;
  details: string;
  createdAt: string;
}

const RECIPE_COLUMNS =
  "id,owner_id,title,short_description,description,instructions,ingredients,servings,image,categories,visibility,created_at,updated_at";

const SEED_TEMPLATE_RECIPES: RecipeModel[] = [
  {
    id: "seed-omelet-vegetables",
    ownerId: "system",
    type: "template",
    isTemplate: true,
    title: "Омлет с овощами",
    shortDescription: "Быстрый завтрак на каждый день",
    instructions:
      "Взбейте яйца с молоком и щепоткой соли. Обжарьте овощи 2-3 минуты, влейте яйца и готовьте под крышкой до готовности.",
    ingredients: [
      { name: "яйца", amount: 3, unit: "шт" },
      { name: "молоко", amount: 50, unit: "мл" },
      { name: "помидоры", amount: 1, unit: "шт" },
      { name: "болгарский перец", amount: 0.5, unit: "шт" },
      { name: "соль", amount: 0, unit: "по вкусу" },
    ],
    notes: "",
    servings: 2,
    image: "/recipes/templates/omelet-vegetables.jpg",
    categories: ["завтрак", "быстро (до 30 минут)", "на каждый день"],
    tags: ["завтрак", "быстро (до 30 минут)", "на каждый день"],
    visibility: "public",
  },
  {
    id: "seed-oatmeal-fruits",
    ownerId: "system",
    type: "template",
    isTemplate: true,
    title: "Овсяная каша с фруктами",
    shortDescription: "Простой полезный завтрак",
    instructions:
      "Доведите молоко с водой до кипения, добавьте овсяные хлопья и варите 5-7 минут. Добавьте банан и яблоко перед подачей.",
    ingredients: [
      { name: "овсяные хлопья", amount: 80, unit: "г" },
      { name: "молоко", amount: 200, unit: "мл" },
      { name: "вода", amount: 100, unit: "мл" },
      { name: "банан", amount: 1, unit: "шт" },
      { name: "яблоко", amount: 1, unit: "шт" },
    ],
    notes: "",
    servings: 2,
    image: "/recipes/templates/oatmeal-fruits.jpg",
    categories: ["завтрак", "на каждый день"],
    tags: ["завтрак", "на каждый день"],
    visibility: "public",
  },
  {
    id: "seed-chicken-rice",
    ownerId: "system",
    type: "template",
    isTemplate: true,
    title: "Курица с рисом",
    shortDescription: "Базовый обед без сложной техники",
    instructions:
      "Обжарьте курицу до легкой корочки, добавьте лук и морковь. Засыпьте рис, влейте воду, накройте крышкой и готовьте 20 минут.",
    ingredients: [
      { name: "куриное филе", amount: 400, unit: "г" },
      { name: "рис", amount: 200, unit: "г" },
      { name: "лук", amount: 1, unit: "шт" },
      { name: "морковь", amount: 1, unit: "шт" },
      { name: "вода", amount: 450, unit: "мл" },
    ],
    notes: "",
    servings: 3,
    image: "/recipes/templates/chicken-rice.jpg",
    categories: ["обед", "на каждый день"],
    tags: ["обед", "на каждый день"],
    visibility: "public",
  },
  {
    id: "seed-baked-fish-potatoes",
    ownerId: "system",
    type: "template",
    isTemplate: true,
    title: "Запеченная рыба с картофелем",
    shortDescription: "Ужин в духовке без лишней суеты",
    instructions:
      "Нарежьте картофель, выложите в форму, сверху рыбу. Посолите, добавьте масло и запекайте 30-35 минут при 190°C.",
    ingredients: [
      { name: "рыбное филе", amount: 500, unit: "г" },
      { name: "картофель", amount: 700, unit: "г" },
      { name: "масло растительное", amount: 20, unit: "мл" },
      { name: "соль", amount: 0, unit: "по вкусу" },
    ],
    notes: "",
    servings: 3,
    image: "/recipes/templates/baked-fish-potatoes.jpg",
    categories: ["ужин", "духовка"],
    tags: ["ужин", "духовка"],
    visibility: "public",
  },
  {
    id: "seed-pasta-tomato",
    ownerId: "system",
    type: "template",
    isTemplate: true,
    title: "Паста с томатным соусом",
    shortDescription: "Универсальный быстрый ужин",
    instructions:
      "Отварите пасту. На сковороде прогрейте томаты с чесноком и маслом 8-10 минут. Смешайте пасту с соусом.",
    ingredients: [
      { name: "паста", amount: 250, unit: "г" },
      { name: "томаты в собственном соку", amount: 400, unit: "г" },
      { name: "чеснок", amount: 2, unit: "зубчик" },
      { name: "масло оливковое", amount: 15, unit: "мл" },
    ],
    notes: "",
    servings: 3,
    image: "/recipes/templates/pasta-tomato.jpg",
    categories: ["ужин", "быстро (до 30 минут)"],
    tags: ["ужин", "быстро (до 30 минут)"],
    visibility: "public",
  },
  {
    id: "seed-tuna-salad",
    ownerId: "system",
    type: "template",
    isTemplate: true,
    title: "Салат с тунцом",
    shortDescription: "Быстрый вариант на обед или ужин",
    instructions:
      "Нарежьте овощи, добавьте тунец и яйцо. Заправьте маслом и лимонным соком, перемешайте.",
    ingredients: [
      { name: "тунец консервированный", amount: 1, unit: "шт" },
      { name: "огурец", amount: 1, unit: "шт" },
      { name: "помидоры", amount: 2, unit: "шт" },
      { name: "яйца", amount: 2, unit: "шт" },
      { name: "масло оливковое", amount: 10, unit: "мл" },
    ],
    notes: "",
    servings: 2,
    image: "/recipes/templates/tuna-salad.jpg",
    categories: ["обед", "быстро (до 30 минут)"],
    tags: ["обед", "быстро (до 30 минут)"],
    visibility: "public",
  },
  {
    id: "seed-oladi-kefir",
    ownerId: "system",
    type: "template",
    isTemplate: true,
    title: "Оладьи на кефире",
    shortDescription: "Базовая выпечка к чаю",
    instructions:
      "Смешайте кефир, яйцо, сахар и муку с разрыхлителем. Жарьте оладьи на среднем огне с двух сторон до румяности.",
    ingredients: [
      { name: "кефир", amount: 250, unit: "мл" },
      { name: "мука", amount: 180, unit: "г" },
      { name: "яйца", amount: 1, unit: "шт" },
      { name: "сахар", amount: 20, unit: "г" },
      { name: "разрыхлитель", amount: 1, unit: "ч.л." },
    ],
    notes: "",
    servings: 3,
    image: "/recipes/templates/oladi-kefir.jpg",
    categories: ["завтрак", "выпечка"],
    tags: ["завтрак", "выпечка"],
    visibility: "public",
  },
];

const cloneRecipeModel = (recipe: RecipeModel): RecipeModel => ({
  ...recipe,
  ingredients: (recipe.ingredients || []).map((item) => ({ ...item })),
  categories: [...(recipe.categories || [])],
  tags: [...(recipe.tags || [])],
});

export const listSeedTemplateRecipes = (): RecipeModel[] =>
  SEED_TEMPLATE_RECIPES.map((item) => cloneRecipeModel(item));

const getSeedTemplateRecipeById = (recipeId: string): RecipeModel | null => {
  const found = SEED_TEMPLATE_RECIPES.find((item) => item.id === recipeId);
  return found ? cloneRecipeModel(found) : null;
};

const readRecipeReports = (): RecipeReportRecord[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECIPE_REPORTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => item as Partial<RecipeReportRecord>)
      .filter((item) => typeof item.recipeId === "string" && item.recipeId.trim().length > 0)
      .map((item) => ({
        recipeId: String(item.recipeId),
        reason: (item.reason as RecipeReportReason) || "Другое",
        details: String(item.details || ""),
        createdAt: String(item.createdAt || new Date().toISOString()),
      }));
  } catch {
    return [];
  }
};

const writeRecipeReports = (reports: RecipeReportRecord[]) => {
  if (typeof window === "undefined") return;
  localStorage.setItem(RECIPE_REPORTS_KEY, JSON.stringify(reports));
};

export const getReportedRecipeIds = (): string[] => {
  const unique = new Set(readRecipeReports().map((item) => item.recipeId));
  return Array.from(unique);
};

export const isRecipeHiddenByReport = (recipeId: string): boolean =>
  getReportedRecipeIds().includes(recipeId);

export const reportRecipeForReview = (
  recipeId: string,
  reason: RecipeReportReason,
  details = ""
): void => {
  const current = readRecipeReports();
  const next: RecipeReportRecord[] = [
    ...current.filter((item) => item.recipeId !== recipeId),
    {
      recipeId,
      reason,
      details: details.trim(),
      createdAt: new Date().toISOString(),
    },
  ];
  writeRecipeReports(next);
};

const isMissingRelationError = (error: unknown, relationName: string): boolean => {
  if (!error || typeof error !== "object") return false;
  const typed = error as PostgrestLikeError;
  const message = String(typed.message || "").toLowerCase();
  const relation = relationName.toLowerCase();
  return typed.code === "42P01" || message.includes(relation) || message.includes("does not exist");
};

const isDuplicateKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const typed = error as PostgrestLikeError;
  const message = String(typed.message || "").toLowerCase();
  return typed.code === "23505" || message.includes("duplicate key");
};

const normalizeTitle = (value: string): string =>
  value.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");

const getRecipeSortTimestamp = (recipe: RecipeModel): number => {
  const updatedAt = Date.parse(recipe.updatedAt || "");
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  const createdAt = Date.parse(recipe.createdAt || "");
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  return 0;
};

const dedupeRecipesByTitle = (recipes: RecipeModel[]): RecipeModel[] => {
  const sorted = [...recipes].sort((a, b) => getRecipeSortTimestamp(b) - getRecipeSortTimestamp(a));
  const byKey = new Map<string, RecipeModel>();

  sorted.forEach((recipe) => {
    const titleKey = normalizeTitle(recipe.title || "");
    const key = titleKey || `id:${recipe.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, recipe);
    }
  });

  return Array.from(byKey.values());
};

const findOwnedRecipeByTitle = async (ownerId: string, title: string): Promise<RecipeModel | null> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .eq("owner_id", ownerId)
    .limit(100);

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data) ? (data as RecipeRow[]) : [];
  const targetTitle = normalizeTitle(title);
  const matched = rows.find((row) => normalizeTitle(row.title || "") === targetTitle);
  return matched ? mapRow(matched) : null;
};

const findOwnedRecipeByTitleSafe = async (ownerId: string, title: string): Promise<RecipeModel | null> => {
  try {
    return await findOwnedRecipeByTitle(ownerId, title);
  } catch (error) {
    if (!isMissingRelationError(error, "recipes")) {
      throw error;
    }
    const cloud = await loadCloudFallbackRecipes(ownerId);
    const targetTitle = normalizeTitle(title);
    return cloud.find((item) => normalizeTitle(item.title || "") === targetTitle) || null;
  }
};

const normalizeIngredients = (value: unknown): Ingredient[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, unknown>;
      const name = String(raw.name || "").trim();
      const unit = String(raw.unit || "").trim();
      const amount = Number(raw.amount || 0);
      if (!name) return null;
      return { name, unit: unit || "г", amount: Number.isFinite(amount) ? amount : 0 };
    })
    .filter((item): item is Ingredient => Boolean(item));
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
};

const serializeRecipeForCloudFallback = (recipe: RecipeModel): Record<string, unknown> => ({
  id: recipe.id,
  title: recipe.title || "Рецепт",
  shortDescription: recipe.shortDescription || "",
  description: recipe.description || "",
  instructions: recipe.instructions || "",
  ingredients: normalizeIngredients(recipe.ingredients),
  notes: recipe.notes || "",
  servings: recipe.servings && recipe.servings > 0 ? recipe.servings : 2,
  image: recipe.image || "",
  categories: normalizeStringArray(recipe.categories),
  tags: normalizeStringArray(recipe.tags || recipe.categories),
  visibility: "private",
  createdAt: recipe.createdAt || new Date().toISOString(),
  updatedAt: recipe.updatedAt || new Date().toISOString(),
});

const mapCloudFallbackItemToRecipe = (ownerId: string, value: unknown): RecipeModel | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || "").trim();
  const title = String(raw.title || "").trim();
  if (!id || !title) return null;

  const categories = normalizeStringArray(raw.categories);
  const tags = normalizeStringArray(raw.tags ?? raw.categories);

  return {
    id,
    ownerId,
    type: "user",
    isTemplate: false,
    title,
    shortDescription: String(raw.shortDescription || ""),
    description: String(raw.description || ""),
    instructions: String(raw.instructions || raw.description || ""),
    ingredients: normalizeIngredients(raw.ingredients),
    notes: String(raw.notes || ""),
    servings: Number(raw.servings || 2),
    image: String(raw.image || ""),
    categories,
    tags: tags.length > 0 ? tags : categories,
    visibility: "private",
    createdAt: String(raw.createdAt || ""),
    updatedAt: String(raw.updatedAt || ""),
  };
};

const loadCloudFallbackRecipes = async (ownerId: string): Promise<RecipeModel[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user || data.user.id !== ownerId) return [];
  const metadata = (data.user.user_metadata || {}) as Record<string, unknown>;
  const rawList = metadata[RECIPES_CLOUD_FALLBACK_KEY];
  if (!Array.isArray(rawList)) return [];
  return dedupeRecipesByTitle(
    rawList
    .map((item) => mapCloudFallbackItemToRecipe(ownerId, item))
    .filter((item): item is RecipeModel => Boolean(item))
  );
};

const saveCloudFallbackRecipes = async (ownerId: string, recipes: RecipeModel[]): Promise<void> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user || data.user.id !== ownerId) {
    throw error || new Error("Supabase user is not available.");
  }

  const existingMetadata = (data.user.user_metadata || {}) as Record<string, unknown>;
  const payload = recipes.map((item) => serializeRecipeForCloudFallback(item));
  const { error: updateError } = await supabase.auth.updateUser({
    data: {
      ...existingMetadata,
      [RECIPES_CLOUD_FALLBACK_KEY]: payload,
    },
  });

  if (updateError) {
    throw updateError;
  }
};

const mapRow = (row: RecipeRow, notes?: string | null): RecipeModel => {
  const tags = normalizeStringArray(row.categories);
  const isTemplate = !row.owner_id;
  return {
    id: row.id,
    ownerId: row.owner_id || "system",
    type: isTemplate ? "template" : "user",
    isTemplate,
    title: row.title,
    shortDescription: row.short_description || "",
    description: row.description || "",
    instructions: row.instructions || "",
    ingredients: normalizeIngredients(row.ingredients),
    notes: notes || "",
    servings: row.servings && row.servings > 0 ? row.servings : 2,
    image: row.image || "",
    categories: tags,
    tags,
    visibility: row.visibility || "private",
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
  };
};

const toPayload = (input: RecipeUpsertInput) => {
  const tags = normalizeStringArray(input.tags ?? input.categories);
  return {
    title: input.title.trim(),
    short_description: (input.shortDescription || "").trim(),
    description: (input.description || "").trim(),
    instructions: (input.instructions || "").trim(),
    ingredients: normalizeIngredients(input.ingredients),
    servings: input.servings && input.servings > 0 ? input.servings : 2,
    image: (input.image || "").trim(),
    categories: tags,
    visibility: input.visibility || "private",
  };
};

export const syncRecipesToLocalCache = (recipes: RecipeModel[]): void => {
  if (typeof window === "undefined") return;
  const mapped = dedupeRecipesByTitle(recipes).map((item) => ({
    id: item.id,
    title: item.title,
    shortDescription: item.shortDescription || "",
    description: item.description || "",
    instructions: item.instructions || "",
    ingredients: item.ingredients || [],
    notes: item.notes || "",
    servings: item.servings || 2,
    image: item.image || "",
    categories: item.categories || [],
    tags: item.tags || item.categories || [],
    visibility: item.visibility || "private",
  }));
  localStorage.setItem(RECIPES_STORAGE_KEY, JSON.stringify(mapped));
};

export const upsertRecipeInLocalCache = (recipe: RecipeModel): void => {
  if (typeof window === "undefined") return;
  const current = loadLocalRecipes();
  const recipeTitleKey = normalizeTitle(recipe.title || "");
  const withoutCurrent = current.filter((item) => {
    if (item.id === recipe.id) return false;
    if (!recipeTitleKey) return true;
    return normalizeTitle(item.title || "") !== recipeTitleKey;
  });
  syncRecipesToLocalCache([recipe, ...withoutCurrent]);
};

export const removeRecipeFromLocalCache = (recipeId: string): void => {
  if (typeof window === "undefined") return;
  const current = loadLocalRecipes().filter((item) => item.id !== recipeId);
  syncRecipesToLocalCache(current);
};

export const loadLocalRecipes = (): RecipeModel[] => {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(RECIPES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeRecipesByTitle(parsed.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        id: String(row.id || crypto.randomUUID()),
        ownerId: "",
        type: "user",
        isTemplate: false,
        title: String(row.title || ""),
        shortDescription: String(row.shortDescription || ""),
        description: String(row.description || ""),
        instructions: String(row.instructions || row.description || ""),
        ingredients: normalizeIngredients(row.ingredients),
        notes: String(row.notes || ""),
        servings: Number(row.servings || 2),
        image: String(row.image || ""),
        categories: normalizeStringArray(row.categories),
        tags: normalizeStringArray(row.tags ?? row.categories),
        visibility: (row.visibility === "public" ? "public" : "private") as RecipeVisibility,
      };
    }));
  } catch {
    return [];
  }
};

export const getCurrentUserId = async (): Promise<string | null> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
};

export const listMyRecipes = async (ownerId: string): Promise<RecipeModel[]> => {
  const supabase = getSupabaseClient();

  const { data: recipeRows, error: recipesError } = await supabase
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .eq("owner_id", ownerId)
    .order("updated_at", { ascending: false });

  if (recipesError) {
    if (isMissingRelationError(recipesError, "recipes")) {
      return loadCloudFallbackRecipes(ownerId);
    }
    throw recipesError;
  }

  const rows = (recipeRows || []) as RecipeRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const { data: noteRows, error: notesError } = await supabase
    .from("recipe_notes")
    .select("recipe_id,notes")
    .eq("owner_id", ownerId)
    .in("recipe_id", ids);

  if (notesError) {
    if (!isMissingRelationError(notesError, "recipe_notes")) {
      throw notesError;
    }
    return rows.map((row) => mapRow(row));
  }

  const notesMap = new Map<string, string>();
  (noteRows as RecipeNoteRow[]).forEach((row) => {
    notesMap.set(row.recipe_id, row.notes || "");
  });

  return dedupeRecipesByTitle(rows.map((row) => mapRow(row, notesMap.get(row.id))));
};

export const listPublicRecipes = async (): Promise<RecipeModel[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .eq("visibility", "public")
    .order("updated_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, "recipes")) {
      return listSeedTemplateRecipes();
    }
    throw error;
  }

  const hidden = new Set(getReportedRecipeIds());
  const dbPublic = ((data || []) as RecipeRow[])
    .map((row) => mapRow(row))
    .filter((row) => !hidden.has(row.id));

  const seedTemplates = listSeedTemplateRecipes();
  const knownTitles = new Set(dbPublic.map((item) => item.title.trim().toLowerCase()));
  const extraTemplates = seedTemplates.filter((item) => !knownTitles.has(item.title.trim().toLowerCase()));

  return [...extraTemplates, ...dbPublic];
};

export const getRecipeById = async (recipeId: string, currentUserId?: string | null): Promise<RecipeModel | null> => {
  const seedTemplate = getSeedTemplateRecipeById(recipeId);
  if (seedTemplate) {
    return seedTemplate;
  }

  const supabase = getSupabaseClient();

  let query = supabase.from("recipes").select(RECIPE_COLUMNS).eq("id", recipeId);
  if (currentUserId) {
    query = query.or(`owner_id.eq.${currentUserId},visibility.eq.public`);
  } else {
    query = query.eq("visibility", "public");
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isMissingRelationError(error, "recipes") && currentUserId) {
      const cloudRecipes = await loadCloudFallbackRecipes(currentUserId);
      return cloudRecipes.find((item) => item.id === recipeId) || null;
    }
    throw error;
  }
  if (!data) return null;

  const row = data as RecipeRow;
  if (row.visibility === "public" && (!currentUserId || row.owner_id !== currentUserId)) {
    if (isRecipeHiddenByReport(row.id)) return null;
  }
  let notes = "";

  if (currentUserId && row.owner_id === currentUserId) {
    const { data: noteData, error: noteError } = await supabase
      .from("recipe_notes")
      .select("recipe_id,notes")
      .eq("recipe_id", recipeId)
      .eq("owner_id", currentUserId)
      .maybeSingle();

    if (noteError) {
      if (!isMissingRelationError(noteError, "recipe_notes")) {
        throw noteError;
      }
    } else {
      notes = (noteData as RecipeNoteRow | null)?.notes || "";
    }
  }

  return mapRow(row, notes);
};

export const createRecipe = async (ownerId: string, input: RecipeUpsertInput): Promise<RecipeModel> => {
  const supabase = getSupabaseClient();
  const payload = toPayload(input);

  const { data, error } = await supabase
    .from("recipes")
    .insert({ ...payload, owner_id: ownerId })
    .select(RECIPE_COLUMNS)
    .single();

  if (error) {
    if (isMissingRelationError(error, "recipes")) {
      const now = new Date().toISOString();
      const cloudRecipes = await loadCloudFallbackRecipes(ownerId);
      const created: RecipeModel = {
        id: crypto.randomUUID(),
        ownerId,
        type: "user",
        isTemplate: false,
        title: payload.title || "Рецепт",
        shortDescription: payload.short_description || "",
        description: payload.description || "",
        instructions: payload.instructions || payload.description || "",
        ingredients: normalizeIngredients(payload.ingredients),
        notes: (input.notes || "").trim(),
        servings: payload.servings && payload.servings > 0 ? payload.servings : 2,
        image: payload.image || "",
        categories: normalizeStringArray(payload.categories),
        tags: normalizeStringArray(payload.categories),
        visibility: "private",
        createdAt: now,
        updatedAt: now,
      };
      await saveCloudFallbackRecipes(ownerId, [created, ...cloudRecipes]);
      return created;
    }
    throw error;
  }

  const created = data as RecipeRow;
  const notes = (input.notes || "").trim();

  if (notes) {
    const { error: notesError } = await supabase
      .from("recipe_notes")
      .upsert({ recipe_id: created.id, owner_id: ownerId, notes }, { onConflict: "recipe_id" });

    if (notesError) {
      if (!isMissingRelationError(notesError, "recipe_notes")) {
        throw notesError;
      }
    }
  }

  return mapRow(created, notes);
};

export const updateRecipe = async (ownerId: string, recipeId: string, input: RecipeUpsertInput): Promise<RecipeModel> => {
  const supabase = getSupabaseClient();
  const payload = toPayload(input);

  const { data, error } = await supabase
    .from("recipes")
    .update(payload)
    .eq("id", recipeId)
    .eq("owner_id", ownerId)
    .select(RECIPE_COLUMNS)
    .single();

  if (error) {
    if (isMissingRelationError(error, "recipes")) {
      const cloudRecipes = await loadCloudFallbackRecipes(ownerId);
      const existing = cloudRecipes.find((item) => item.id === recipeId);
      if (!existing) {
        throw error;
      }
      const now = new Date().toISOString();
      const updated: RecipeModel = {
        ...existing,
        title: payload.title || existing.title,
        shortDescription: payload.short_description || "",
        description: payload.description || "",
        instructions: payload.instructions || payload.description || "",
        ingredients: normalizeIngredients(payload.ingredients),
        notes: (input.notes || "").trim(),
        servings: payload.servings && payload.servings > 0 ? payload.servings : 2,
        image: payload.image || "",
        categories: normalizeStringArray(payload.categories),
        tags: normalizeStringArray(payload.categories),
        visibility: payload.visibility || "private",
        updatedAt: now,
      };
      const next = [updated, ...cloudRecipes.filter((item) => item.id !== recipeId)];
      await saveCloudFallbackRecipes(ownerId, next);
      return updated;
    }
    throw error;
  }

  const notes = (input.notes || "").trim();
  if (notes) {
    const { error: notesError } = await supabase
      .from("recipe_notes")
      .upsert({ recipe_id: recipeId, owner_id: ownerId, notes }, { onConflict: "recipe_id" });
    if (notesError) {
      if (!isMissingRelationError(notesError, "recipe_notes")) {
        throw notesError;
      }
    }
  } else {
    const { error: deleteNoteError } = await supabase
      .from("recipe_notes")
      .delete()
      .eq("recipe_id", recipeId)
      .eq("owner_id", ownerId);
    if (deleteNoteError) {
      if (!isMissingRelationError(deleteNoteError, "recipe_notes")) {
        throw deleteNoteError;
      }
    }
  }

  return mapRow(data as RecipeRow, notes);
};

export const deleteRecipe = async (ownerId: string, recipeId: string): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("recipes").delete().eq("id", recipeId).eq("owner_id", ownerId);
  if (error) {
    if (isMissingRelationError(error, "recipes")) {
      const cloudRecipes = await loadCloudFallbackRecipes(ownerId);
      const next = cloudRecipes.filter((item) => item.id !== recipeId);
      await saveCloudFallbackRecipes(ownerId, next);
      return;
    }
    throw error;
  }
};

export const deleteAllMyRecipes = async (ownerId: string): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("recipes").delete().eq("owner_id", ownerId);
  if (error) {
    if (isMissingRelationError(error, "recipes")) {
      await saveCloudFallbackRecipes(ownerId, []);
      return;
    }
    throw error;
  }
};

export const copyPublicRecipeToMine = async (ownerId: string, recipeId: string): Promise<RecipeModel> => {
  const supabase = getSupabaseClient();
  const seedTemplate = getSeedTemplateRecipeById(recipeId);

  if (seedTemplate) {
    const payload = {
      owner_id: ownerId,
      title: seedTemplate.title,
      short_description: seedTemplate.shortDescription || "",
      description: seedTemplate.description || "",
      instructions: seedTemplate.instructions || "",
      ingredients: normalizeIngredients(seedTemplate.ingredients),
      servings: seedTemplate.servings && seedTemplate.servings > 0 ? seedTemplate.servings : 2,
      image: seedTemplate.image || "",
      categories: [...(seedTemplate.tags || seedTemplate.categories || [])],
      visibility: "private" as RecipeVisibility,
    };

    const existing = await findOwnedRecipeByTitleSafe(ownerId, payload.title);
    if (existing) return existing;

    const { data, error } = await supabase
      .from("recipes")
      .insert(payload)
      .select(RECIPE_COLUMNS)
      .single();

    if (error) {
      if (isMissingRelationError(error, "recipes")) {
        const cloudRecipes = await loadCloudFallbackRecipes(ownerId);
        const targetTitle = normalizeTitle(payload.title);
        const existingCloud = cloudRecipes.find((item) => normalizeTitle(item.title || "") === targetTitle);
        if (existingCloud) return existingCloud;
        const now = new Date().toISOString();
        const created: RecipeModel = {
          id: crypto.randomUUID(),
          ownerId,
          type: "user",
          isTemplate: false,
          title: payload.title || "Рецепт",
          shortDescription: payload.short_description || "",
          description: payload.description || "",
          instructions: payload.instructions || payload.description || "",
          ingredients: normalizeIngredients(payload.ingredients),
          notes: "",
          servings: payload.servings && payload.servings > 0 ? payload.servings : 2,
          image: payload.image || "",
          categories: normalizeStringArray(payload.categories),
          tags: normalizeStringArray(payload.categories),
          visibility: "private",
          createdAt: now,
          updatedAt: now,
        };
        await saveCloudFallbackRecipes(ownerId, [created, ...cloudRecipes]);
        return created;
      }
      if (isDuplicateKeyError(error)) {
        const existing = await findOwnedRecipeByTitle(ownerId, payload.title);
        if (existing) return existing;
      }
      throw error;
    }

    return mapRow(data as RecipeRow);
  }

  const { data: sourceData, error: sourceError } = await supabase
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .eq("id", recipeId)
    .eq("visibility", "public")
    .single();

  if (sourceError) {
    throw sourceError;
  }

  const source = sourceData as RecipeRow;
  const payload = {
    owner_id: ownerId,
    title: source.title,
    short_description: source.short_description || "",
    description: source.description || "",
    instructions: source.instructions || "",
    ingredients: normalizeIngredients(source.ingredients),
    servings: source.servings && source.servings > 0 ? source.servings : 2,
    image: source.image || "",
    categories: Array.isArray(source.categories) ? source.categories : [],
    visibility: "private" as RecipeVisibility,
  };

  const existing = await findOwnedRecipeByTitleSafe(ownerId, payload.title);
  if (existing) return existing;

  const { data, error } = await supabase
    .from("recipes")
    .insert(payload)
    .select(RECIPE_COLUMNS)
    .single();

  if (error) {
    if (isMissingRelationError(error, "recipes")) {
      const cloudRecipes = await loadCloudFallbackRecipes(ownerId);
      const targetTitle = normalizeTitle(payload.title);
      const existingCloud = cloudRecipes.find((item) => normalizeTitle(item.title || "") === targetTitle);
      if (existingCloud) return existingCloud;
      const now = new Date().toISOString();
      const created: RecipeModel = {
        id: crypto.randomUUID(),
        ownerId,
        type: "user",
        isTemplate: false,
        title: payload.title || "Рецепт",
        shortDescription: payload.short_description || "",
        description: payload.description || "",
        instructions: payload.instructions || payload.description || "",
        ingredients: normalizeIngredients(payload.ingredients),
        notes: "",
        servings: payload.servings && payload.servings > 0 ? payload.servings : 2,
        image: payload.image || "",
        categories: normalizeStringArray(payload.categories),
        tags: normalizeStringArray(payload.categories),
        visibility: "private",
        createdAt: now,
        updatedAt: now,
      };
      await saveCloudFallbackRecipes(ownerId, [created, ...cloudRecipes]);
      return created;
    }
    if (isDuplicateKeyError(error)) {
      const existing = await findOwnedRecipeByTitle(ownerId, payload.title);
      if (existing) return existing;
    }
    throw error;
  }

  return mapRow(data as RecipeRow);
};

export const importLocalRecipesIfNeeded = async (ownerId: string): Promise<number> => {
  if (typeof window === "undefined") return 0;

  const supabase = getSupabaseClient();
  const local = loadLocalRecipes();
  if (local.length === 0) return 0;

  const { count, error: countError } = await supabase
    .from("recipes")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId);

  if (countError) {
    if (isMissingRelationError(countError, "recipes")) {
      const cloud = await loadCloudFallbackRecipes(ownerId);
      if (cloud.length > 0) return 0;
      let importedFallback = 0;
      for (const item of local) {
        const created = await createRecipe(ownerId, {
          title: item.title,
          shortDescription: item.shortDescription,
          description: item.description,
          instructions: item.instructions || item.description,
          ingredients: item.ingredients || [],
          notes: item.notes,
          servings: item.servings,
          image: item.image,
          categories: item.categories,
          tags: item.tags || item.categories,
          visibility: "private",
        });
        if (created.id) importedFallback += 1;
      }
      return importedFallback;
    }
    throw countError;
  }
  if ((count || 0) > 0) return 0;

  let imported = 0;
  for (const item of local) {
    const created = await createRecipe(ownerId, {
      title: item.title,
      shortDescription: item.shortDescription,
      description: item.description,
      instructions: item.instructions || item.description,
      ingredients: item.ingredients || [],
      notes: item.notes,
      servings: item.servings,
      image: item.image,
      categories: item.categories,
      tags: item.tags || item.categories,
      visibility: "private",
    });

    if (created.id) {
      imported += 1;
    }
  }

  return imported;
};

