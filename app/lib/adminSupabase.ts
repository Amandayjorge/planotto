"use client";

import type { User } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabaseClient";
import { normalizePlanTier, resolvePlanTierFromMetadata, type PlanTier } from "./subscription";

export type AdminLanguage = "ru" | "en" | "es";
export type AdminSubscriptionStatus = "inactive" | "trial" | "active" | "past_due" | "canceled";

const ADMIN_LANGUAGES: AdminLanguage[] = ["ru", "en", "es"];

interface AdminRecipeRow {
  id: string;
  owner_id: string | null;
  title: string;
  base_language: string | null;
  visibility: string | null;
  updated_at: string | null;
}

interface AdminRecipeTranslationRow {
  recipe_id: string;
  language: string;
  title: string;
  is_auto_generated: boolean | null;
  updated_at: string | null;
}

interface AdminIngredientRow {
  id: string;
  category_id: string | null;
}

interface AdminIngredientTranslationRow {
  ingredient_id: string;
  language: string;
  name: string;
}

interface AdminCategoryRow {
  id: string;
}

interface AdminCategoryTranslationRow {
  category_id: string;
  language: string;
  name: string;
}

interface UserProfileRow {
  user_id: string;
  email: string;
  display_name: string | null;
  ui_language: string | null;
  plan_tier: string | null;
  subscription_status: string | null;
  is_blocked: boolean | null;
  is_test_access: boolean | null;
  pro_expires_at: string | null;
  updated_at: string | null;
}

export interface AdminRecipe {
  id: string;
  ownerId: string;
  title: string;
  baseLanguage: AdminLanguage;
  visibility: "private" | "public" | "link" | "invited";
  updatedAt: string;
  translationLanguages: AdminLanguage[];
  missingTranslations: AdminLanguage[];
}

export interface AdminIngredient {
  id: string;
  categoryId: string;
  names: Record<AdminLanguage, string>;
}

export interface AdminIngredientCategory {
  id: string;
  names: Record<AdminLanguage, string>;
}

export interface AdminUserProfile {
  userId: string;
  email: string;
  displayName: string;
  uiLanguage: AdminLanguage;
  planTier: PlanTier;
  subscriptionStatus: AdminSubscriptionStatus;
  isBlocked: boolean;
  isTestAccess: boolean;
  proExpiresAt: string;
  updatedAt: string;
}

const isNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code || "");
  const message = String((error as { message?: unknown }).message || "").toLowerCase();
  return code === "PGRST116" || message.includes("0 rows");
};

const resolveUserName = (user: User | null | undefined): string => {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const rawName =
    metadata.full_name ?? metadata.name ?? metadata.nickname ?? metadata.user_name;

  if (typeof rawName === "string" && rawName.trim()) {
    return rawName.trim();
  }

  const email = user?.email || "";
  const firstPart = email.split("@")[0] || "";
  const normalized = firstPart.replace(/[._-]+/g, " ").trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const toLanguage = (value: unknown, fallback: AdminLanguage = "ru"): AdminLanguage => {
  const normalized = String(value || "").trim().toLowerCase();
  return ADMIN_LANGUAGES.includes(normalized as AdminLanguage)
    ? (normalized as AdminLanguage)
    : fallback;
};

const toSubscriptionStatus = (value: unknown): AdminSubscriptionStatus => {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "inactive" ||
    normalized === "trial" ||
    normalized === "active" ||
    normalized === "past_due" ||
    normalized === "canceled"
  ) {
    return normalized;
  }
  return "inactive";
};

const toVisibility = (value: unknown): "private" | "public" | "link" | "invited" => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "private" || normalized === "public" || normalized === "link" || normalized === "invited") {
    return normalized;
  }
  return "private";
};

const toIsoDateTime = (value: string | null | undefined): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
};

export const ensureCurrentUserProfile = async (): Promise<void> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return;

  const metadata = (data.user.user_metadata || {}) as Record<string, unknown>;
  const userLanguage = toLanguage(
    metadata.ui_language,
    "ru"
  );
  const rawAvatar = metadata.avatar_url ?? metadata.picture;
  const avatarUrl = typeof rawAvatar === "string" && rawAvatar.trim() ? rawAvatar.trim() : null;

  const basePayload = {
    p_email: data.user.email || null,
    p_display_name: resolveUserName(data.user),
    p_ui_language: userLanguage,
  };
  const { error: upsertError } = await supabase.rpc("upsert_my_profile", {
    ...basePayload,
    p_avatar_url: avatarUrl,
  });
  if (!upsertError) return;

  const code = String((upsertError as { code?: unknown }).code || "");
  const message = String((upsertError as { message?: unknown }).message || "").toLowerCase();
  const canFallbackToLegacySignature =
    code === "42883"
    || (message.includes("upsert_my_profile") && message.includes("function") && message.includes("does not exist"));

  if (!canFallbackToLegacySignature) {
    throw upsertError;
  }

  const { error: fallbackError } = await supabase.rpc("upsert_my_profile", basePayload);
  if (fallbackError) throw fallbackError;
};

export const isCurrentUserAdmin = async (): Promise<boolean> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("is_admin");
  if (error) return false;
  return Boolean(data);
};

export const resolveCurrentUserPlanTier = async (): Promise<PlanTier> => {
  const supabase = getSupabaseClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return "free";

  const fallbackPlan = resolvePlanTierFromMetadata(
    (authData.user.user_metadata || null) as Record<string, unknown> | null
  );

  const { data, error } = await supabase
    .from("user_profiles")
    .select("plan_tier")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (error && !isNotFoundError(error)) return fallbackPlan;
  if (!data || typeof data !== "object") return fallbackPlan;
  return normalizePlanTier((data as { plan_tier?: unknown }).plan_tier);
};

export const loadAdminRecipes = async (): Promise<AdminRecipe[]> => {
  const supabase = getSupabaseClient();

  const [{ data: recipeRows, error: recipeError }, { data: translationRows, error: translationError }] =
    await Promise.all([
      supabase
        .from("recipes")
        .select("id,owner_id,title,base_language,visibility,updated_at")
        .order("updated_at", { ascending: false }),
      supabase
        .from("recipe_translations")
        .select("recipe_id,language,title,is_auto_generated,updated_at"),
    ]);

  if (recipeError) throw new Error(recipeError.message || "Failed to load recipes");
  if (translationError) throw new Error(translationError.message || "Failed to load translations");

  const translationMap = new Map<string, Set<AdminLanguage>>();
  (translationRows || []).forEach((row) => {
    const typed = row as AdminRecipeTranslationRow;
    const recipeId = String(typed.recipe_id || "").trim();
    const language = toLanguage(typed.language, "ru");
    if (!recipeId) return;
    if (!translationMap.has(recipeId)) {
      translationMap.set(recipeId, new Set<AdminLanguage>());
    }
    translationMap.get(recipeId)?.add(language);
  });

  return (recipeRows || []).map((row) => {
    const typed = row as AdminRecipeRow;
    const recipeId = String(typed.id || "").trim();
    const languages = Array.from(translationMap.get(recipeId) || []);
    const missingTranslations = ADMIN_LANGUAGES.filter((language) => !languages.includes(language));

    return {
      id: recipeId,
      ownerId: String(typed.owner_id || ""),
      title: String(typed.title || ""),
      baseLanguage: toLanguage(typed.base_language, "ru"),
      visibility: toVisibility(typed.visibility),
      updatedAt: toIsoDateTime(typed.updated_at),
      translationLanguages: languages,
      missingTranslations,
    };
  });
};

export const bulkUpdateRecipes = async (
  recipeIds: string[],
  patch: {
    baseLanguage?: AdminLanguage;
    visibility?: "private" | "public" | "link" | "invited";
  }
): Promise<void> => {
  const normalizedIds = recipeIds
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (normalizedIds.length === 0) return;

  const payload: Record<string, unknown> = {};
  if (patch.baseLanguage) payload.base_language = patch.baseLanguage;
  if (patch.visibility) payload.visibility = patch.visibility;
  if (Object.keys(payload).length === 0) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("recipes")
    .update(payload)
    .in("id", normalizedIds);

  if (error) throw new Error(error.message || "Failed to update recipes");
};

export const loadAdminIngredients = async (): Promise<{
  ingredients: AdminIngredient[];
  categories: AdminIngredientCategory[];
}> => {
  const supabase = getSupabaseClient();
  const [
    { data: ingredientRows, error: ingredientError },
    { data: ingredientTranslationRows, error: ingredientTranslationError },
    { data: categoryRows, error: categoryError },
    { data: categoryTranslationRows, error: categoryTranslationError },
  ] = await Promise.all([
    supabase.from("ingredient_dictionary").select("id,category_id").order("id", { ascending: true }),
    supabase.from("ingredient_translations").select("ingredient_id,language,name"),
    supabase.from("ingredient_categories").select("id").order("id", { ascending: true }),
    supabase.from("ingredient_category_translations").select("category_id,language,name"),
  ]);

  if (ingredientError) throw new Error(ingredientError.message || "Failed to load ingredients");
  if (ingredientTranslationError) throw new Error(ingredientTranslationError.message || "Failed to load ingredient translations");
  if (categoryError) throw new Error(categoryError.message || "Failed to load categories");
  if (categoryTranslationError) throw new Error(categoryTranslationError.message || "Failed to load category translations");

  const ingredientNameMap = new Map<string, Record<AdminLanguage, string>>();
  (ingredientTranslationRows || []).forEach((row) => {
    const typed = row as AdminIngredientTranslationRow;
    const ingredientId = String(typed.ingredient_id || "").trim();
    if (!ingredientId) return;
    if (!ingredientNameMap.has(ingredientId)) {
      ingredientNameMap.set(ingredientId, { ru: "", en: "", es: "" });
    }
    const lang = toLanguage(typed.language, "ru");
    ingredientNameMap.get(ingredientId)![lang] = String(typed.name || "");
  });

  const categoryNameMap = new Map<string, Record<AdminLanguage, string>>();
  (categoryTranslationRows || []).forEach((row) => {
    const typed = row as AdminCategoryTranslationRow;
    const categoryId = String(typed.category_id || "").trim();
    if (!categoryId) return;
    if (!categoryNameMap.has(categoryId)) {
      categoryNameMap.set(categoryId, { ru: "", en: "", es: "" });
    }
    const lang = toLanguage(typed.language, "ru");
    categoryNameMap.get(categoryId)![lang] = String(typed.name || "");
  });

  const ingredients = (ingredientRows || []).map((row) => {
    const typed = row as AdminIngredientRow;
    const ingredientId = String(typed.id || "").trim();
    return {
      id: ingredientId,
      categoryId: String(typed.category_id || "other"),
      names: ingredientNameMap.get(ingredientId) || { ru: "", en: "", es: "" },
    };
  });

  const categories = (categoryRows || []).map((row) => {
    const typed = row as AdminCategoryRow;
    const categoryId = String(typed.id || "").trim();
    return {
      id: categoryId,
      names: categoryNameMap.get(categoryId) || { ru: "", en: "", es: "" },
    };
  });

  return { ingredients, categories };
};

export const updateIngredientCategory = async (ingredientId: string, categoryId: string): Promise<void> => {
  const normalizedIngredientId = String(ingredientId || "").trim();
  const normalizedCategoryId = String(categoryId || "").trim();
  if (!normalizedIngredientId || !normalizedCategoryId) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("ingredient_dictionary")
    .update({ category_id: normalizedCategoryId })
    .eq("id", normalizedIngredientId);

  if (error) throw new Error(error.message || "Failed to update ingredient category");
};

export const upsertIngredientTranslation = async (
  ingredientId: string,
  language: AdminLanguage,
  name: string
): Promise<void> => {
  const normalizedIngredientId = String(ingredientId || "").trim();
  const normalizedName = String(name || "").trim();
  if (!normalizedIngredientId || !normalizedName) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("ingredient_translations")
    .upsert(
      {
        ingredient_id: normalizedIngredientId,
        language,
        name: normalizedName,
      },
      { onConflict: "ingredient_id,language" }
    );

  if (error) throw new Error(error.message || "Failed to upsert ingredient translation");
};

export const createIngredient = async (ingredientId: string, categoryId: string): Promise<void> => {
  const normalizedIngredientId = String(ingredientId || "").trim();
  const normalizedCategoryId = String(categoryId || "").trim() || "other";
  if (!normalizedIngredientId) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("ingredient_dictionary")
    .insert({
      id: normalizedIngredientId,
      category_id: normalizedCategoryId,
    });

  if (error) throw new Error(error.message || "Failed to create ingredient");
};

export const mergeIngredientInto = async (
  sourceIngredientId: string,
  targetIngredientId: string
): Promise<number> => {
  const normalizedSource = String(sourceIngredientId || "").trim();
  const normalizedTarget = String(targetIngredientId || "").trim();
  if (!normalizedSource || !normalizedTarget) return 0;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("admin_merge_ingredients", {
    p_source_id: normalizedSource,
    p_target_id: normalizedTarget,
  });

  if (error) throw new Error(error.message || "Failed to merge ingredients");
  return Number(data || 0);
};

export const loadAdminUserProfiles = async (): Promise<AdminUserProfile[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("user_id,email,display_name,ui_language,plan_tier,subscription_status,is_blocked,is_test_access,pro_expires_at,updated_at")
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "Failed to load users");

  return (data || []).map((row) => {
    const typed = row as UserProfileRow;
    return {
      userId: String(typed.user_id || ""),
      email: String(typed.email || ""),
      displayName: String(typed.display_name || ""),
      uiLanguage: toLanguage(typed.ui_language, "ru"),
      planTier: normalizePlanTier(typed.plan_tier),
      subscriptionStatus: toSubscriptionStatus(typed.subscription_status),
      isBlocked: Boolean(typed.is_blocked),
      isTestAccess: Boolean(typed.is_test_access),
      proExpiresAt: toIsoDateTime(typed.pro_expires_at),
      updatedAt: toIsoDateTime(typed.updated_at),
    };
  });
};

export const updateAdminUserProfile = async (
  userId: string,
  patch: Partial<{
    planTier: PlanTier;
    subscriptionStatus: AdminSubscriptionStatus;
    isBlocked: boolean;
    isTestAccess: boolean;
    proExpiresAt: string;
    uiLanguage: AdminLanguage;
    displayName: string;
  }>
): Promise<void> => {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;

  const payload: Record<string, unknown> = {};
  if (patch.planTier) payload.plan_tier = patch.planTier;
  if (patch.subscriptionStatus) payload.subscription_status = patch.subscriptionStatus;
  if (typeof patch.isBlocked === "boolean") payload.is_blocked = patch.isBlocked;
  if (typeof patch.isTestAccess === "boolean") payload.is_test_access = patch.isTestAccess;
  if (patch.proExpiresAt !== undefined) payload.pro_expires_at = patch.proExpiresAt || null;
  if (patch.uiLanguage) payload.ui_language = patch.uiLanguage;
  if (patch.displayName !== undefined) payload.display_name = patch.displayName || null;
  if (Object.keys(payload).length === 0) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("user_profiles")
    .update(payload)
    .eq("user_id", normalizedUserId);

  if (error) throw new Error(error.message || "Failed to update user profile");
};

export const grantTestProAccess = async (userId: string, days = 14): Promise<void> => {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 14));
  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + safeDays);

  await updateAdminUserProfile(userId, {
    planTier: "pro",
    subscriptionStatus: "trial",
    isTestAccess: true,
    proExpiresAt: expirationDate.toISOString(),
  });
};
