"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";
import { useI18n } from "../components/I18nProvider";
import {
  findIngredientIdByName,
  getIngredientCategoryIdByIngredientId,
  getIngredientNameById,
  type IngredientCategoryId,
} from "../lib/ingredientDictionary";
import {
  DEFAULT_UNIT_ID,
  getUnitLabel,
  getUnitLabelById,
  getUnitOptions,
  normalizeUnitId,
  type UnitId,
} from "../lib/ingredientUnits";

interface PantryItem {
  name: string;
  amount: number;
  unitId?: UnitId;
  unit_id?: UnitId;
  unit: string;
  category: PantryCategoryId;
  updatedAt: string;
}

interface PantryDraftItem {
  name: string;
  amount: number | "";
  unitId: UnitId;
  unit: string;
  category: PantryCategoryId;
}

type SortMode = "name" | "amount" | "updatedAt";
type PantryCategoryId =
  | "vegetablesFruits"
  | "meatFish"
  | "dairy"
  | "dryGoods"
  | "frozen"
  | "drinks"
  | "household"
  | "other";
interface PantryCategory {
  id: PantryCategoryId;
  emoji: string;
  labelKey: string;
}

const PANTRY_STORAGE_KEY = "pantry";
const CATEGORY_FILTER_ALL = "__all__";
const DEFAULT_PANTRY_CATEGORY_ID: PantryCategoryId = "other";
const PANTRY_CATEGORIES: readonly PantryCategory[] = [
  { id: "vegetablesFruits", emoji: "🥦", labelKey: "pantry.categories.vegetablesFruits" },
  { id: "meatFish", emoji: "🥩", labelKey: "pantry.categories.meatFish" },
  { id: "dairy", emoji: "🧀", labelKey: "pantry.categories.dairy" },
  { id: "dryGoods", emoji: "🥫", labelKey: "pantry.categories.dryGoods" },
  { id: "frozen", emoji: "🧊", labelKey: "pantry.categories.frozen" },
  { id: "drinks", emoji: "🧃", labelKey: "pantry.categories.drinks" },
  { id: "household", emoji: "🧽", labelKey: "pantry.categories.household" },
  { id: "other", emoji: "📦", labelKey: "pantry.categories.other" },
];
const PANTRY_CATEGORY_ID_SET = new Set<string>(PANTRY_CATEGORIES.map((item) => item.id));
const CATEGORY_EMOJI_BY_INGREDIENT_CATEGORY: Record<IngredientCategoryId, string> = {
  vegetables: "🥬",
  fruits: "🍎",
  protein: "🍗",
  dairy: "🧀",
  grocery: "🥫",
  bakery: "🥖",
  drinks: "🧃",
  other: "📦",
};
const PANTRY_CATEGORY_BY_INGREDIENT_CATEGORY: Record<IngredientCategoryId, PantryCategoryId> = {
  vegetables: "vegetablesFruits",
  fruits: "vegetablesFruits",
  protein: "meatFish",
  dairy: "dairy",
  grocery: "dryGoods",
  bakery: "dryGoods",
  drinks: "drinks",
  other: "other",
};

interface PantrySuggestionOption {
  key: string;
  name: string;
  category: PantryCategoryId;
  emoji: string;
  isCreateNew?: boolean;
}

const nowIso = (): string => new Date().toISOString();
const resolveIntlLocale = (locale: string): string => {
  if (locale === "ru") return "ru-RU";
  if (locale === "es") return "es-ES";
  return "en-US";
};
const resolveIngredientLocale = (locale: string): "ru" | "en" | "es" => {
  if (locale === "es") return "es";
  if (locale === "en") return "en";
  return "ru";
};
const normalizeLookupText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/\s+/g, " ");

const PANTRY_CATEGORY_ALIAS_TO_ID: Record<string, PantryCategoryId> = {
  vegetablesfruits: "vegetablesFruits",
  "vegetables fruits": "vegetablesFruits",
  "frutas y verduras": "vegetablesFruits",
  "fruits and vegetables": "vegetablesFruits",
  "овощи и фрукты": "vegetablesFruits",

  meatfish: "meatFish",
  "meat and fish": "meatFish",
  "carne y pescado": "meatFish",
  "мясо и рыба": "meatFish",

  dairy: "dairy",
  "dairy products": "dairy",
  lacteos: "dairy",
  "молочные продукты": "dairy",

  drygoods: "dryGoods",
  grocery: "dryGoods",
  groceries: "dryGoods",
  breadbakery: "dryGoods",
  "bakery and bread": "dryGoods",
  "pan y bolleria": "dryGoods",
  "despensa seca": "dryGoods",
  secos: "dryGoods",
  бакалея: "dryGoods",

  frozen: "frozen",
  congelados: "frozen",
  заморозка: "frozen",

  drinks: "drinks",
  bebidas: "drinks",
  напитки: "drinks",

  household: "household",
  "para casa": "household",
  "для дома": "household",

  other: "other",
  otros: "other",
  uncategorized: "other",
  "sin categoria": "other",
  "без категории": "other",
};

const normalizePantryCategoryId = (value: unknown): PantryCategoryId => {
  if (typeof value !== "string") return DEFAULT_PANTRY_CATEGORY_ID;
  const raw = value.trim();
  if (!raw) return DEFAULT_PANTRY_CATEGORY_ID;
  if (PANTRY_CATEGORY_ID_SET.has(raw)) return raw as PantryCategoryId;
  const normalized = normalizeLookupText(raw);
  return PANTRY_CATEGORY_ALIAS_TO_ID[normalized] || DEFAULT_PANTRY_CATEGORY_ID;
};

const normalizePantryItem = (raw: unknown): PantryItem | null => {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<PantryItem>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const amount = Number(row.amount);
  const unit = typeof row.unit === "string" ? row.unit : "";
  const unitId = normalizeUnitId(row.unitId || row.unit_id || unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID);
  if (!name || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    name,
    amount,
    unitId,
    unit: unit || getUnitLabelById(unitId, "en"),
    category: normalizePantryCategoryId(row.category),
    updatedAt: typeof row.updatedAt === "string" && row.updatedAt.trim() ? row.updatedAt : nowIso(),
  };
};

const getProductEmoji = (name: string, locale: "ru" | "en" | "es"): string => {
  const ingredientId = findIngredientIdByName(name, locale);
  if (!ingredientId) return "📦";
  const categoryId = getIngredientCategoryIdByIngredientId(ingredientId);
  return CATEGORY_EMOJI_BY_INGREDIENT_CATEGORY[categoryId] || "📦";
};

const formatUpdatedLabel = (
  iso: string,
  locale: string,
  t: (key: string, params?: Record<string, string | number>) => string
): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t("pantry.updated.unknown");
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayStart.getTime() - targetStart.getTime()) / 86400000);
  if (diffDays === 0) return t("pantry.updated.today");
  if (diffDays === 1) return t("pantry.updated.yesterday");
  return targetStart.toLocaleDateString(resolveIntlLocale(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const isUpdatedToday = (iso: string): boolean => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
};

const getProductWord = (
  count: number,
  t: (key: string, params?: Record<string, string | number>) => string
): string => {
  const abs = Math.abs(count) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return t("pantry.words.productsPlural");
  if (tail === 1) return t("pantry.words.productOne");
  if (tail >= 2 && tail <= 4) return t("pantry.words.productFew");
  return t("pantry.words.productsPlural");
};

export default function PantryPage() {
  const { locale, t } = useI18n();
  const activeLocale = resolveIntlLocale(locale);
  const unitOptions = getUnitOptions(locale);
  const [pantry, setPantry] = useState<PantryItem[]>(() => {
    if (typeof window === "undefined") return [];
    const storedPantry = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (!storedPantry) return [];
    try {
      const parsed = JSON.parse(storedPantry);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => normalizePantryItem(item))
        .filter((item): item is PantryItem => Boolean(item));
    } catch {
      return [];
    }
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftItem, setDraftItem] = useState<PantryDraftItem | null>(null);
  const [activeSuggestionField, setActiveSuggestionField] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(CATEGORY_FILTER_ALL);
  const [sortMode, setSortMode] = useState<SortMode>("updatedAt");
  const [productSuggestions, setProductSuggestions] = useState<string[]>(() => loadProductSuggestions());

  useEffect(() => {
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(pantry));
  }, [pantry]);

  const validateItem = (item: PantryDraftItem, index?: string): boolean => {
    const newErrors = { ...errors };
    const key = index || "new";
    delete newErrors[key];

    if (!item.name.trim()) {
      newErrors[key] = t("pantry.validation.nameRequired");
    } else if (item.amount === "") {
      newErrors[key] = t("pantry.validation.amountRequired");
    } else if (!Number.isFinite(item.amount) || item.amount <= 0) {
      newErrors[key] = t("pantry.validation.amountPositive");
    }

    setErrors(newErrors);
    return !newErrors[key];
  };

  const startEdit = (index: number) => {
    const unitId = normalizeUnitId(
      pantry[index].unitId || pantry[index].unit_id || pantry[index].unit || DEFAULT_UNIT_ID,
      DEFAULT_UNIT_ID
    );
    setEditingId(`edit-${index}`);
    setDraftItem({
      name: pantry[index].name,
      amount: pantry[index].amount > 0 ? pantry[index].amount : "",
      unitId,
      unit: getUnitLabelById(unitId, locale),
      category: normalizePantryCategoryId(pantry[index].category),
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftItem(null);
    setActiveSuggestionField(null);
    setErrors({});
  };

  const upsertSuggestions = (name: string) => {
    const normalized = name.trim();
    if (!normalized) return;
    appendProductSuggestions([normalized]);
    setProductSuggestions(loadProductSuggestions());
  };

  const saveEdit = () => {
    if (!draftItem || !editingId) return;
    if (!validateItem(draftItem, editingId)) return;

    const normalizedName = canonicalizeProductName(draftItem.name.trim());
    if (!normalizedName) return;
    const normalizedCategory = normalizePantryCategoryId(draftItem.category);
    const inferredCategory = resolveSuggestionCategory(normalizedName, normalizedCategory);
    const payload: PantryItem = {
      name: normalizedName,
      amount: Number(draftItem.amount),
      unitId: draftItem.unitId,
      unit: getUnitLabelById(draftItem.unitId, locale),
      category: inferredCategory,
      updatedAt: nowIso(),
    };

    upsertSuggestions(payload.name);

    if (editingId === "new") {
      const existingIndex = findExistingPantryIndex(payload.name, payload.unitId ?? DEFAULT_UNIT_ID);
      if (existingIndex >= 0) {
        setPantry((prev) =>
          prev.map((item, index) =>
            index === existingIndex
              ? {
                  ...item,
                  amount: Number((item.amount + payload.amount).toFixed(2)),
                  category: payload.category,
                  updatedAt: nowIso(),
                }
              : item
          )
        );
      } else {
        setPantry((prev) => [...prev, payload]);
      }
    } else {
      const index = Number(editingId.replace("edit-", ""));
      const existingIndex = findExistingPantryIndex(payload.name, payload.unitId ?? DEFAULT_UNIT_ID, index);
      if (existingIndex >= 0) {
        setPantry((prev) => {
          const next = [...prev];
          const target = next[existingIndex];
          if (!target) return prev;
          next[existingIndex] = {
            ...target,
            amount: Number((target.amount + payload.amount).toFixed(2)),
            category: payload.category,
            updatedAt: nowIso(),
          };
          next.splice(index, 1);
          return next;
        });
      } else {
        setPantry((prev) => prev.map((item, i) => (i === index ? payload : item)));
      }
    }

    setEditingId(null);
    setDraftItem(null);
    setActiveSuggestionField(null);
  };

  const updateDraftItem = (field: "name" | "amount" | "unit" | "category", value: string | number) => {
    if (!draftItem) return;
    const updated = { ...draftItem };

    if (field === "name") {
      updated.name = String(value);
      const exactPantryMatchCategory = findPantryCategoryByName(updated.name);
      if (exactPantryMatchCategory) {
        updated.category = exactPantryMatchCategory;
      }
    }
    if (field === "amount") {
      const raw = String(value).trim();
      if (!raw) {
        updated.amount = "";
      } else {
        const parsed = Number(raw);
        updated.amount = Number.isFinite(parsed) ? parsed : "";
      }
    }
    if (field === "unit") {
      const nextUnitId = normalizeUnitId(value, DEFAULT_UNIT_ID);
      updated.unitId = nextUnitId;
      updated.unit = getUnitLabelById(nextUnitId, locale);
    }
    if (field === "category") updated.category = normalizePantryCategoryId(value);

    setDraftItem(updated);
    validateItem(updated, editingId || undefined);
  };

  const removePantryItem = (index: number) => {
    setPantry((prev) => prev.filter((_, i) => i !== index));
  };

  const addPantryItem = () => {
    setEditingId("new");
    setDraftItem({
      name: "",
      amount: "",
      unitId: DEFAULT_UNIT_ID,
      unit: getUnitLabelById(DEFAULT_UNIT_ID, locale),
      category: DEFAULT_PANTRY_CATEGORY_ID,
    });
    setActiveSuggestionField("new");
  };

  const addStarterPantryItems = () => {
    if (editingId !== null) return;
    const starterItems: PantryItem[] = [
      {
        name: t("pantry.starter.milk"),
        amount: 1,
        unitId: "l",
        unit: getUnitLabelById("l", locale),
        category: DEFAULT_PANTRY_CATEGORY_ID,
        updatedAt: nowIso(),
      },
      {
        name: t("pantry.starter.eggs"),
        amount: 10,
        unitId: "pcs",
        unit: getUnitLabelById("pcs", locale),
        category: DEFAULT_PANTRY_CATEGORY_ID,
        updatedAt: nowIso(),
      },
      {
        name: t("pantry.starter.bread"),
        amount: 1,
        unitId: "pcs",
        unit: getUnitLabelById("pcs", locale),
        category: DEFAULT_PANTRY_CATEGORY_ID,
        updatedAt: nowIso(),
      },
    ];
    setPantry((prev) => [...prev, ...starterItems]);
    appendProductSuggestions(starterItems.map((item) => item.name));
    setProductSuggestions(loadProductSuggestions());
  };
  const ingredientLocale = resolveIngredientLocale(locale);
  const pantryCategoryEntries = PANTRY_CATEGORIES.map((item) => ({
    ...item,
    label: t(item.labelKey),
  }));
  const pantryCategoryLabelMap = new Map<PantryCategoryId, string>(
    pantryCategoryEntries.map((item) => [item.id, item.label])
  );

  const normalizeProductName = (value: string): string => value.trim().replace(/\s+/g, " ");
  const canonicalizeProductName = (value: string): string => {
    const normalized = normalizeProductName(value);
    if (!normalized) return "";
    const ingredientId = findIngredientIdByName(normalized, ingredientLocale);
    if (!ingredientId) return normalized;
    return getIngredientNameById(ingredientId, ingredientLocale, normalized) || normalized;
  };
  const resolveSuggestionCategory = (
    name: string,
    preferredCategory?: PantryCategoryId
  ): PantryCategoryId => {
    if (preferredCategory && PANTRY_CATEGORY_ID_SET.has(preferredCategory)) return preferredCategory;
    const ingredientId = findIngredientIdByName(name, ingredientLocale);
    if (!ingredientId) return DEFAULT_PANTRY_CATEGORY_ID;
    const ingredientCategoryId = getIngredientCategoryIdByIngredientId(ingredientId, "other");
    return PANTRY_CATEGORY_BY_INGREDIENT_CATEGORY[ingredientCategoryId] || DEFAULT_PANTRY_CATEGORY_ID;
  };

  const findPantryCategoryByName = (value: string): PantryCategoryId | null => {
    const canonicalName = canonicalizeProductName(value);
    const lookup = normalizeLookupText(canonicalName);
    if (!lookup) return null;
    const match = pantry.find((item) => normalizeLookupText(item.name) === lookup);
    return match ? normalizePantryCategoryId(match.category) : null;
  };

  const findExistingPantryIndex = (name: string, unitId: UnitId, ignoreIndex?: number): number => {
    const nameKey = normalizeLookupText(name);
    return pantry.findIndex((item, index) => {
      if (index === ignoreIndex) return false;
      const itemKey = normalizeLookupText(item.name || "");
      if (itemKey !== nameKey) return false;
      const itemUnitId = normalizeUnitId(item.unitId || item.unit_id || item.unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID);
      return itemUnitId === unitId;
    });
  };

  const getSuggestionOptions = (value: string): PantrySuggestionOption[] => {
    const typedName = normalizeProductName(value);
    const normalizedQuery = normalizeLookupText(typedName);
    if (normalizedQuery.length < 2) return [];

    const options = new Map<string, PantrySuggestionOption>();
    const pushOption = (rawName: string, preferredCategory?: PantryCategoryId) => {
      const sourceName = normalizeProductName(rawName);
      if (!sourceName) return;
      const canonicalName = canonicalizeProductName(sourceName);
      const suggestionKey = normalizeLookupText(canonicalName);
      if (!suggestionKey) return;
      if (!suggestionKey.includes(normalizedQuery)) return;
      if (options.has(suggestionKey)) return;
      const category = resolveSuggestionCategory(canonicalName, preferredCategory);
      options.set(suggestionKey, {
        key: suggestionKey,
        name: canonicalName,
        category,
        emoji: getProductEmoji(canonicalName, ingredientLocale),
      });
    };

    pantry.forEach((item) => pushOption(item.name, item.category));
    productSuggestions.forEach((name) => pushOption(name));

    const sorted = Array.from(options.values())
      .sort((a, b) => {
        const aStarts = normalizeLookupText(a.name).startsWith(normalizedQuery) ? 0 : 1;
        const bStarts = normalizeLookupText(b.name).startsWith(normalizedQuery) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name, activeLocale, { sensitivity: "base" });
      })
      .slice(0, 6);

    const exactKey = normalizeLookupText(canonicalizeProductName(typedName));
    if (!options.has(exactKey)) {
      sorted.push({
        key: `new:${exactKey}`,
        name: typedName,
        category: DEFAULT_PANTRY_CATEGORY_ID,
        emoji: "➕",
        isCreateNew: true,
      });
    }

    return sorted;
  };

  const applySuggestionOption = (option: PantrySuggestionOption) => {
    if (!draftItem) return;
    const normalizedName = normalizeProductName(option.name);
    if (!normalizedName) return;
    const nextCategory = option.isCreateNew ? draftItem.category : option.category;
    const updated: PantryDraftItem = {
      ...draftItem,
      name: normalizedName,
      category: nextCategory,
    };
    setDraftItem(updated);
    validateItem(updated, editingId || undefined);
    setActiveSuggestionField(null);
  };

  const normalizedSearch = normalizeLookupText(searchQuery);
  const categoryChips: Array<{ value: string; label: string; emoji?: string }> = [
    { value: CATEGORY_FILTER_ALL, label: t("pantry.filters.all") },
    ...pantryCategoryEntries.map((category) => ({
      value: category.id,
      label: category.label,
      emoji: category.emoji,
    })),
  ];

  const visibleItems = pantry
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (normalizedSearch && !normalizeLookupText(item.name).includes(normalizedSearch)) return false;
      if (categoryFilter !== CATEGORY_FILTER_ALL) {
        if (!PANTRY_CATEGORY_ID_SET.has(categoryFilter)) return false;
        if (item.category !== categoryFilter) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortMode === "name") {
        return a.item.name.localeCompare(b.item.name, activeLocale, { sensitivity: "base" });
      }
      if (sortMode === "amount") {
        if (b.item.amount !== a.item.amount) return b.item.amount - a.item.amount;
        return a.item.name.localeCompare(b.item.name, activeLocale, { sensitivity: "base" });
      }
      const aTime = Date.parse(a.item.updatedAt || "");
      const bTime = Date.parse(b.item.updatedAt || "");
      const safeATime = Number.isFinite(aTime) ? aTime : 0;
      const safeBTime = Number.isFinite(bTime) ? bTime : 0;
      if (safeBTime !== safeATime) return safeBTime - safeATime;
      return a.item.name.localeCompare(b.item.name, activeLocale, { sensitivity: "base" });
    });

  const pantryCountLabel =
    pantry.length < 5
      ? t("pantry.count.inPantry", {
          count: pantry.length,
          word: getProductWord(pantry.length, t),
        })
      : t("pantry.count.available", {
          count: pantry.length,
          word: getProductWord(pantry.length, t),
        });

  const renderEditorFields = (currentItem: PantryDraftItem, suggestionKey: string, errorKey: string) => (
    <>
      <div className="pantry-name-input-wrap">
        <input
          type="text"
          value={currentItem.name}
          onChange={(e) => {
            updateDraftItem("name", e.target.value);
            setActiveSuggestionField(suggestionKey);
          }}
          onFocus={() => setActiveSuggestionField(suggestionKey)}
          onBlur={() => {
            setTimeout(() => {
              setActiveSuggestionField((prev) => (prev === suggestionKey ? null : prev));
            }, 120);
          }}
          placeholder={t("pantry.form.namePlaceholder")}
          className="input"
          style={{ borderColor: errors[errorKey] ? "var(--state-warning)" : undefined }}
          autoFocus={editingId === suggestionKey}
          autoComplete="off"
        />
        {activeSuggestionField === suggestionKey && (
          <div className="pantry-suggestions">
            {getSuggestionOptions(currentItem.name).map((option) => (
              <button
                key={option.key}
                type="button"
                className="pantry-suggestion"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applySuggestionOption(option)}
              >
                <span className="pantry-suggestion__row">
                  <span className="pantry-suggestion__emoji" aria-hidden="true">{option.emoji}</span>
                  <span className="pantry-suggestion__name">
                    {option.isCreateNew ? t("pantry.form.createNewProduct") : option.name}
                  </span>
                </span>
                {!option.isCreateNew && option.category ? (
                  <span className="pantry-suggestion__meta">
                    {pantryCategoryLabelMap.get(option.category) || t("pantry.categories.other")}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
      {errors[errorKey] ? (
        <div style={{ color: "var(--state-warning)", fontSize: "12px", marginTop: "4px" }}>{errors[errorKey]}</div>
      ) : null}
      <div className="pantry-card__editor-grid">
        <input
          type="number"
          value={currentItem.amount === "" ? "" : currentItem.amount}
          onChange={(e) => updateDraftItem("amount", e.target.value)}
          placeholder="0"
          step="0.1"
          min="0"
          className="input"
        />
        <select
          value={currentItem.unitId}
          onChange={(e) => updateDraftItem("unit", e.target.value)}
          className="input"
        >
          {unitOptions.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.label}
            </option>
          ))}
        </select>
      </div>
      <select
        value={currentItem.category}
        onChange={(e) => updateDraftItem("category", e.target.value)}
        className="input"
      >
        {pantryCategoryEntries.map((category) => (
          <option key={category.id} value={category.id}>
            {category.label}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <section className="card pantry-page">
      <div style={{ marginBottom: "20px" }}>
        <Link href="/menu" className="btn" style={{ marginRight: "20px" }}>
          {t("pantry.actions.backToMenu")}
        </Link>
      </div>

      <h1 className="h1" style={{ marginBottom: "20px", color: "var(--text-primary)" }}>
        {t("pantry.title")}
      </h1>

      <p className="pantry-count-label">
        <span aria-hidden="true">📦</span>
        <span>{pantryCountLabel}</span>
      </p>

      <div className="pantry-toolbar">
        <button onClick={addPantryItem} className="btn btn-add" disabled={editingId !== null}>
          {t("pantry.actions.addProduct")}
        </button>
        {pantry.length > 0 ? (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("pantry.form.searchPlaceholder")}
            className="input"
            style={{ maxWidth: "320px" }}
          />
        ) : null}
        <select
          className="input"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          style={{ maxWidth: "260px" }}
        >
          <option value="updatedAt">{t("pantry.sort.updatedAt")}</option>
          <option value="name">{t("pantry.sort.name")}</option>
          <option value="amount">{t("pantry.sort.amount")}</option>
        </select>
      </div>

      <div className="pantry-category-strip">
        <div className="pantry-category-chips">
          {categoryChips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={`pantry-chip${categoryFilter === chip.value ? " pantry-chip--active" : ""}`}
              onClick={() => setCategoryFilter(chip.value)}
            >
              {chip.emoji ? `${chip.emoji} ` : ""}
              {chip.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pantry-category-hint" aria-hidden="true">{t("pantry.filters.scrollHint")}</div>

      {pantry.length === 0 && editingId !== "new" ? (
        <div className="empty-state">
          <div className="empty-state__title">{t("pantry.empty.title")}</div>
          <div className="empty-state__description">{t("pantry.empty.description1")}</div>
          <div className="empty-state__description">{t("pantry.empty.description2")}</div>
          <div style={{ marginTop: "16px", display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
            <button onClick={addStarterPantryItems} className="btn btn-primary" disabled={editingId !== null}>
              {t("pantry.actions.addStarter")}
            </button>
            <Link href="/shopping-list" className="btn">
              {t("pantry.actions.openShopping")}
            </Link>
          </div>
        </div>
      ) : visibleItems.length === 0 && editingId !== "new" ? (
        <div className="empty-state">
          <div className="empty-state__title">{t("pantry.empty.notFound")}</div>
        </div>
      ) : (
        <div className="pantry-cards">
          {editingId === "new" && draftItem && (
            <article className="pantry-card pantry-card--new">
              <div className="pantry-card__title">
                <span className="pantry-card__emoji">➕</span>
                <span>{t("pantry.editor.addTitle")}</span>
              </div>
              {renderEditorFields(draftItem, "new", "new")}
              <div className="pantry-card__actions">
                <button
                  onClick={saveEdit}
                  className="btn btn-primary"
                  disabled={!draftItem.name.trim() || draftItem.amount === "" || draftItem.amount <= 0}
                >
                  {t("pantry.actions.save")}
                </button>
                <button onClick={cancelEdit} className="btn">
                  {t("pantry.actions.cancel")}
                </button>
              </div>
            </article>
          )}

          {visibleItems.map(({ item, index }) => {
            const isEditing = editingId === `edit-${index}`;
            const fallbackUnitId = normalizeUnitId(
              item.unitId || item.unit_id || item.unit || DEFAULT_UNIT_ID,
              DEFAULT_UNIT_ID
            );
            const currentItem: PantryDraftItem = isEditing && draftItem
              ? draftItem
              : {
                  name: item.name,
                  amount: item.amount,
                  unitId: fallbackUnitId,
                  unit: getUnitLabelById(fallbackUnitId, locale),
                  category: normalizePantryCategoryId(item.category),
                };
            const cardEmoji = getProductEmoji(item.name, locale);

            return (
              <article key={index} className={`pantry-card${isEditing ? " pantry-card--editing" : ""}`}>
                {isEditing ? (
                  <>
                    <div className="pantry-card__title">
                      <span className="pantry-card__emoji">{cardEmoji}</span>
                      <span>{t("pantry.editor.editTitle")}</span>
                    </div>
                    {renderEditorFields(currentItem, `edit-${index}`, `edit-${index}`)}
                    <div className="pantry-card__actions">
                      <button
                        onClick={saveEdit}
                        className="btn btn-primary"
                        disabled={!currentItem.name.trim() || currentItem.amount === "" || currentItem.amount <= 0}
                      >
                        {t("pantry.actions.save")}
                      </button>
                      <button onClick={cancelEdit} className="btn">
                        {t("pantry.actions.cancel")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="pantry-card__title">
                      <span className="pantry-card__emoji">{cardEmoji}</span>
                      <span>{item.name}</span>
                    </div>
                    <div className="pantry-card__amount">
                      {item.amount} {getUnitLabel(item.unitId || item.unit, locale, item.unit)}
                    </div>
                    <div className="pantry-card__meta-row">
                      <div className="pantry-card__updated">
                        <span
                          className={`pantry-card__updated-dot${isUpdatedToday(item.updatedAt) ? " pantry-card__updated-dot--today" : ""}`}
                          aria-hidden="true"
                        />
                        <span>
                          {t("pantry.updated.label")} {formatUpdatedLabel(item.updatedAt, locale, t)}
                        </span>
                      </div>
                      <div className="pantry-card__actions pantry-card__actions--compact">
                        <button
                          onClick={() => startEdit(index)}
                          className="btn pantry-card__icon-btn"
                          aria-label={t("pantry.actions.editItemAria", { name: item.name })}
                          title={t("pantry.actions.edit")}
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => removePantryItem(index)}
                          className="btn pantry-card__icon-btn pantry-card__icon-btn--danger"
                          aria-label={t("pantry.actions.deleteItemAria", { name: item.name })}
                          title={t("pantry.actions.delete")}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}


      <div style={{ marginTop: "30px", fontSize: "14px", color: "var(--text-secondary)" }}>
        <p>{t("pantry.savedCount", { count: pantry.length })}</p>
      </div>
    </section>
  );
}
