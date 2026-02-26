export type PlanTier = "free" | "pro";

export type PaidFeature =
  | "ai_translation"
  | "recipe_import"
  | "image_generation"
  | "multiple_menus"
  | "advanced_filters"
  | "avatar_frames"
  | "pdf_export";

export const PLAN_TIER_STORAGE_KEY = "planotto:plan-tier";

const PLAN_PROFILE_FIELDS = [
  "plan_tier",
  "subscription_tier",
  "subscription_plan",
  "billing_plan",
  "plan",
] as const;

const PRO_VALUES = new Set(["pro", "premium", "paid", "plus"]);

export const normalizePlanTier = (value: unknown): PlanTier => {
  const normalized = String(value || "").trim().toLowerCase();
  return PRO_VALUES.has(normalized) ? "pro" : "free";
};

export const resolvePlanTierFromMetadata = (
  metadata: Record<string, unknown> | null | undefined
): PlanTier => {
  if (!metadata || typeof metadata !== "object") return "free";
  for (const field of PLAN_PROFILE_FIELDS) {
    if (field in metadata) {
      return normalizePlanTier(metadata[field]);
    }
  }
  return "free";
};

export const readCachedPlanTier = (): PlanTier => {
  if (typeof window === "undefined") return "free";
  try {
    return normalizePlanTier(window.localStorage.getItem(PLAN_TIER_STORAGE_KEY) || "");
  } catch {
    return "free";
  }
};

export const cachePlanTier = (planTier: PlanTier): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PLAN_TIER_STORAGE_KEY, planTier);
  } catch {
    // ignore storage errors in restricted environments
  }
};

export const isPaidFeatureEnabled = (
  planTier: PlanTier,
  feature: PaidFeature
): boolean => {
  switch (feature) {
    case "ai_translation":
    case "recipe_import":
    case "image_generation":
    case "multiple_menus":
    case "advanced_filters":
    case "avatar_frames":
    case "pdf_export":
      return planTier === "pro";
    default:
      return false;
  }
};
