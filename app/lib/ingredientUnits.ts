export type UnitLocale = "ru" | "en" | "es";

export type UnitId =
  | "g"
  | "kg"
  | "ml"
  | "l"
  | "pcs"
  | "tsp"
  | "tbsp"
  | "to_taste"
  | "pinch"
  | "clove";

interface UnitDefinition {
  id: UnitId;
  labels: Record<UnitLocale, string>;
  aliases?: string[];
}

export const DEFAULT_UNIT_ID: UnitId = "g";
export const UNIT_TO_TASTE_ID: UnitId = "to_taste";

const UNIT_DEFINITIONS: UnitDefinition[] = [
  { id: "g", labels: { ru: "г", en: "g", es: "g" } },
  { id: "kg", labels: { ru: "кг", en: "kg", es: "kg" } },
  { id: "ml", labels: { ru: "мл", en: "ml", es: "ml" } },
  { id: "l", labels: { ru: "л", en: "l", es: "l" } },
  { id: "pcs", labels: { ru: "шт", en: "pcs", es: "uds" }, aliases: ["piece", "pieces", "unidad", "unidades"] },
  { id: "tsp", labels: { ru: "ч.л.", en: "tsp", es: "cdta" }, aliases: ["teaspoon", "cucharadita"] },
  { id: "tbsp", labels: { ru: "ст.л.", en: "tbsp", es: "cda" }, aliases: ["tablespoon", "cucharada"] },
  { id: "to_taste", labels: { ru: "по вкусу", en: "to taste", es: "al gusto" }, aliases: ["немного", "a gusto"] },
  { id: "pinch", labels: { ru: "щепотка", en: "pinch", es: "pizca" } },
  { id: "clove", labels: { ru: "зубчик", en: "clove", es: "diente" }, aliases: ["зуб.", "cloves", "dientes"] },
];

const UNIT_BY_ID = new Map<UnitId, UnitDefinition>(UNIT_DEFINITIONS.map((entry) => [entry.id, entry]));
const UNIT_ID_SET = new Set<UnitId>(UNIT_DEFINITIONS.map((entry) => entry.id));

const normalizeUnitText = (value: string): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[.,/()[\]{}%]/g, " ")
    .replace(/\s+/g, " ");

const UNIT_ALIASES = new Map<string, UnitId>();
UNIT_DEFINITIONS.forEach((entry) => {
  UNIT_ALIASES.set(normalizeUnitText(entry.id), entry.id);
  (["ru", "en", "es"] as const).forEach((locale) => {
    UNIT_ALIASES.set(normalizeUnitText(entry.labels[locale]), entry.id);
  });
  (entry.aliases || []).forEach((alias) => UNIT_ALIASES.set(normalizeUnitText(alias), entry.id));
});

export const tryNormalizeUnitId = (value: unknown): UnitId | null => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (UNIT_ID_SET.has(raw as UnitId)) return raw as UnitId;
  const normalized = normalizeUnitText(raw);
  if (!normalized) return null;
  return UNIT_ALIASES.get(normalized) || null;
};

export const normalizeUnitId = (value: unknown, fallback: UnitId = DEFAULT_UNIT_ID): UnitId =>
  tryNormalizeUnitId(value) || fallback;

export const getUnitLabelById = (unitId: UnitId, locale: UnitLocale): string => {
  const found = UNIT_BY_ID.get(unitId);
  if (!found) return UNIT_BY_ID.get(DEFAULT_UNIT_ID)?.labels[locale] || "g";
  return found.labels[locale] || found.labels.ru;
};

export const getUnitLabel = (value: unknown, locale: UnitLocale, fallback = ""): string => {
  const id = tryNormalizeUnitId(value);
  if (!id) return fallback || String(value || "").trim();
  return getUnitLabelById(id, locale);
};

export const isTasteLikeUnit = (value: unknown): boolean =>
  tryNormalizeUnitId(value) === UNIT_TO_TASTE_ID;

export const getUnitOptions = (
  locale: UnitLocale
): Array<{ id: UnitId; label: string }> =>
  UNIT_DEFINITIONS.map((entry) => ({
    id: entry.id,
    label: entry.labels[locale] || entry.labels.ru,
  }));
