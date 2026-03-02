export type NutritionMode = "per_100g" | "per_serving";

export interface NutritionInfo {
  mode: NutritionMode;
  calories?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
}

export interface NutritionFormValues {
  calories: string;
  protein: string;
  fat: string;
  carbs: string;
}

const parseNumber = (value: unknown): number | undefined => {
  if (value == null) return undefined;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : undefined;
};

const hasNutritionData = (info: NutritionInfo): boolean =>
  typeof info.calories === "number" ||
  typeof info.protein === "number" ||
  typeof info.fat === "number" ||
  typeof info.carbs === "number";

const normalizeMode = (value: unknown): NutritionMode => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "per_100g" || raw === "100g") return "per_100g";
  if (raw === "per_serving" || raw === "portion" || raw === "serving") return "per_serving";
  return "per_serving";
};

export const normalizeNutritionRow = (value: unknown): NutritionInfo | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const info: NutritionInfo = {
    mode: normalizeMode(raw.mode),
    calories: parseNumber(raw.calories),
    protein: parseNumber(raw.protein),
    fat: parseNumber(raw.fat),
    carbs: parseNumber(raw.carbs),
  };
  return hasNutritionData(info) ? info : undefined;
};

export const formatNutritionValue = (value?: number): string =>
  value == null ? "" : String(value);

export const buildNutritionFormValues = (info?: NutritionInfo): NutritionFormValues => ({
  calories: formatNutritionValue(info?.calories),
  protein: formatNutritionValue(info?.protein),
  fat: formatNutritionValue(info?.fat),
  carbs: formatNutritionValue(info?.carbs),
});

export const buildNutritionInfoFromForm = (
  mode: NutritionMode,
  values: NutritionFormValues
): NutritionInfo | undefined => {
  const info: NutritionInfo = {
    mode,
    calories: parseNumber(values.calories),
    protein: parseNumber(values.protein),
    fat: parseNumber(values.fat),
    carbs: parseNumber(values.carbs),
  };
  return hasNutritionData(info) ? info : undefined;
};
