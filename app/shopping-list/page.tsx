"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { appendProductSuggestions } from "../lib/productSuggestions";
import {
  findIngredientIdByName,
  getIngredientCategoryIdByIngredientId,
  getIngredientNameById,
  type IngredientCategoryId,
} from "../lib/ingredientDictionary";
import {
  getUnitLabel,
  isTasteLikeUnit,
  tryNormalizeUnitId,
  type UnitId,
} from "../lib/ingredientUnits";
import { useI18n } from "../components/I18nProvider";
import { readProfileGoalFromStorage, type ProfileGoal } from "../lib/profileGoal";
import {
  SHOPPING_PRINT_SNAPSHOT_KEY,
  type ShoppingPrintItem,
  type ShoppingPrintSection,
  type ShoppingPrintSnapshot,
} from "./printSnapshot";

interface Ingredient {
  ingredientId?: string;
  ingredient_id?: string;
  unitId?: UnitId;
  unit_id?: UnitId;
  name: string;
  amount: number;
  unit: string;
}

interface Recipe {
  id: string;
  title: string;
  ingredients?: Ingredient[];
  servings?: number;
}

interface MenuItem {
  id?: string;
  type: "recipe" | "text";
  recipeId?: string;
  value?: string;
  includeInShopping?: boolean;
  ingredients?: Ingredient[];
  cooked?: boolean;
}

interface MenuProfileState {
  id: string;
  name: string;
  mealData: Record<string, MenuItem[]>;
  cellPeopleCount: Record<string, number>;
  cookedStatus: Record<string, boolean>;
}

interface MenuStorageBundleV2 {
  version: 2;
  activeMenuId: string;
  menus: MenuProfileState[];
}

interface GroupedIngredient {
  name: string;
  totalAmount: number;
  unit: string;
  unitId?: UnitId;
  category: StoreCategoryId;
  ingredientId?: string;
  id?: string;
  isManual?: boolean;
}

interface ManualShoppingItem {
  id: string;
  name: string;
  amount: number;
  unit: string;
}

interface PantryItem {
  name: string;
  unit: string;
  amount: number;
}

type StoreCategoryId = "vegetables" | "meat" | "dairy" | "grocery" | "other";

const STORE_CATEGORY_ORDER: StoreCategoryId[] = ["vegetables", "meat", "dairy", "grocery", "other"];
const PRIMARY_STORE_CATEGORIES: StoreCategoryId[] = STORE_CATEGORY_ORDER.filter(
  (category) => category !== "other"
);

const STORE_CATEGORY_KEYWORDS: Record<StoreCategoryId, string[]> = {
  vegetables: ["овощ", "картофел", "морков", "огур", "помид", "капуст", "перец", "баклаж", "редис", "лук", "чеснок", "зелень", "свекл", "тыкв", "шпинат", "vegetable", "tomat", "onion", "garlic", "pepper", "verdur", "tomate", "cebolla", "ajo", "pimient"],
  meat: ["мяс", "куриц", "индейк", "цыплен", "фарш", "бекон", "колбас", "ветчин", "сосис", "стейк", "говяд", "свинин", "телятина", "beef", "chicken", "turkey", "ham", "sausage", "carne", "pollo", "ternera", "jamon"],
  dairy: ["молок", "сыр", "творог", "кефир", "йогурт", "масло", "сливк", "сметан", "ряжен", "кумыс", "морожен", "milk", "cheese", "cream", "yogurt", "butter", "leche", "queso", "nata", "yogur", "mantequilla", "lacte"],
  grocery: [
    "мук",
    "рис",
    "макар",
    "круп",
    "овсян",
    "гречк",
    "горох",
    "фасол",
    "соль",
    "перец",
    "майонез",
    "соус",
    "консерв",
    "чай",
    "кофе",
    "мед",
    "орех",
    "сахар",
    "каша",
    "сухар",
    "хлеб",
    "пряник",
    "сухоф",
    "масло",
    "мускат",
    "flour",
    "rice",
    "pasta",
    "oat",
    "salt",
    "sugar",
    "harina",
    "arroz",
    "pasta",
    "sal",
    "azucar"
  ],
  other: [],
};

const mapIngredientCategoryToStoreCategory = (categoryId: IngredientCategoryId): StoreCategoryId => {
  if (categoryId === "vegetables" || categoryId === "fruits") return "vegetables";
  if (categoryId === "protein") return "meat";
  if (categoryId === "dairy") return "dairy";
  if (categoryId === "grocery" || categoryId === "bakery") return "grocery";
  return "other";
};

const resolveIngredientId = (
  ingredient: Pick<Ingredient, "ingredientId" | "ingredient_id" | "name">
): string | null => {
  const legacy = ingredient.ingredient_id;
  const direct = String(ingredient.ingredientId || legacy || "").trim();
  if (direct) return direct;
  const byName = findIngredientIdByName(ingredient.name || "");
  return byName || null;
};

const categorizeIngredient = (ingredient: Ingredient): StoreCategoryId => {
  const resolvedId = resolveIngredientId(ingredient);
  if (resolvedId) {
    return mapIngredientCategoryToStoreCategory(getIngredientCategoryIdByIngredientId(resolvedId));
  }

  const normalized = normalizeString(ingredient.name).toLowerCase();
  for (const category of PRIMARY_STORE_CATEGORIES) {
    const keywords = STORE_CATEGORY_KEYWORDS[category] || [];
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return category;
    }
  }
  return "other";
};

const MENU_STORAGE_KEY = "weeklyMenu";
const RECIPES_STORAGE_KEY = "recipes";
const PANTRY_STORAGE_KEY = "pantry";
const WEEK_START_KEY = "selectedWeekStart";
const SHOPPING_PERIOD_KEY = "shoppingSelectedPeriod";
const SHOPPING_RANGE_KEY = SHOPPING_PERIOD_KEY;
const RANGE_STATE_KEY = "selectedMenuRange";
const GUEST_REMINDER_VISITS_KEY = "guestReminderVisits";
const GUEST_REMINDER_PERIOD_ATTEMPTS_KEY = "guestReminderPeriodAttempts";
const GUEST_REMINDER_PENDING_KEY = "guestReminderPending";
const GUEST_REMINDER_VISITS_THRESHOLD = 3;
const GUEST_REMINDER_RECIPES_THRESHOLD = 3;
const MANUAL_ITEMS_KEY = "manualShoppingItems";
const SHOPPING_SELECTED_MENU_ID_KEY = "shoppingSelectedMenuId";
const SHOPPING_SELECTED_MENU_NAME_KEY = "shoppingSelectedMenuName";
const SHOPPING_USE_MERGED_MENUS_KEY = "shoppingUseMergedMenus";
const SHOPPING_SETTINGS_KEY = "shoppingListSettingsV1";

interface ShoppingListSettings {
  includeCookedDishes: boolean;
  mergeMenus: boolean;
  defaultDatePreset: "today" | "tomorrow" | "period";
  groupByCategories: boolean;
}

const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const formatDate = (date: Date): string => {
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
};

const resolveIntlLocale = (locale: string): string => {
  if (locale === "ru") return "ru-RU";
  if (locale === "es") return "es-ES";
  return "en-US";
};

const formatDisplayDate = (date: Date, locale = "en"): string => {
  return date.toLocaleDateString(resolveIntlLocale(locale), { day: "2-digit", month: "2-digit" });
};

interface MenuPeriodOption {
  storageSuffix: string;
  start: string;
  end: string;
  label: string;
}

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

const parsePeriodFromSuffix = (suffix: string): { start: string; end: string } | null => {
  if (suffix.includes("__")) {
    const [start, end] = suffix.split("__");
    if (isIsoDate(start) && isIsoDate(end)) return { start, end };
    return null;
  }
  if (isIsoDate(suffix)) {
    const startDate = new Date(suffix);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    return { start: suffix, end: formatDate(endDate) };
  }
  return null;
};

const getPeriodLabel = (start: string, end: string): string => {
  return `${formatDisplayDate(new Date(start))}-${formatDisplayDate(new Date(end))}`;
};

const normalizeString = (str: string): string => {
  return str.trim().toLowerCase().replace(/\s+/g, " ");
};

const getUnitStorageKey = (unit: string, unitId?: UnitId): string => {
  const normalizedId = tryNormalizeUnitId(unitId || unit);
  if (normalizedId) return `id:${normalizedId}`;
  return `txt:${normalizeString(unit)}`;
};

const normalizeKey = (name: string, unit: string, unitId?: UnitId): string => {
  return `${normalizeString(name)}|${getUnitStorageKey(unit, unitId)}`;
};

const normalizeMenuDataRecord = (value: unknown): Record<string, MenuItem[]> => {
  if (!value || typeof value !== "object") return {};
  const converted: Record<string, MenuItem[]> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, rawCell]) => {
    const rows = Array.isArray(rawCell) ? rawCell : [rawCell];
    converted[key] = rows
      .filter((row) => row && typeof row === "object")
      .map((row) => row as MenuItem);
  });
  return converted;
};

const normalizePeopleCountMap = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  const map: Record<string, number> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, raw]) => {
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) map[key] = num;
  });
  return map;
};

const normalizeCookedStatusMap = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== "object") return {};
  const map: Record<string, boolean> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, raw]) => {
    map[key] = raw === true;
  });
  return map;
};

const parseMenuProfilesFromRangeStorage = (
  raw: string | null,
  fallbackCounts: Record<string, number>,
  fallbackCooked: Record<string, boolean>
): MenuProfileState[] => {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Partial<MenuStorageBundleV2>).version === 2 &&
      Array.isArray((parsed as Partial<MenuStorageBundleV2>).menus)
    ) {
      return ((parsed as Partial<MenuStorageBundleV2>).menus || [])
        .map((menu) => menu as Partial<MenuProfileState>)
        .filter((menu) => typeof menu.name === "string" && menu.name.trim().length > 0)
        .map((menu) => ({
          id: typeof menu.id === "string" && menu.id ? menu.id : crypto.randomUUID(),
          name: String(menu.name || "").trim(),
          mealData: normalizeMenuDataRecord(menu.mealData),
          cellPeopleCount: normalizePeopleCountMap(menu.cellPeopleCount),
          cookedStatus: normalizeCookedStatusMap(menu.cookedStatus),
        }));
    }

    return [
      {
        id: "default",
        name: "Main",
        mealData: normalizeMenuDataRecord(parsed),
        cellPeopleCount: fallbackCounts,
        cookedStatus: fallbackCooked,
      },
    ];
  } catch {
    return [];
  }
};

const ensureWeekStart = (): string => {
  if (typeof window === "undefined") {
    return formatDate(getMonday(new Date()));
  }

  let weekStart = localStorage.getItem(WEEK_START_KEY);
  if (!weekStart) {
    weekStart = formatDate(getMonday(new Date()));
    localStorage.setItem(WEEK_START_KEY, weekStart);
  }

  return weekStart;
};

const addDays = (date: Date, days: number): Date => {
  const clone = new Date(date);
  clone.setDate(clone.getDate() + days);
  return clone;
};

const buildPeriodDates = (weekStart: string, weeks: number): string[] => {
  const startDate = new Date(weekStart);
  const count = Math.max(1, weeks) * 7;
  const dates: string[] = [];

  for (let i = 0; i < count; i++) {
    const next = addDays(startDate, i);
    dates.push(formatDate(next));
  }

  return dates;
};

type QuickDatePreset = "today" | "tomorrow" | "period";

const loadManualItemsFromStorage = (menuScopeKey = "default"): ManualShoppingItem[] => {
  if (typeof window === "undefined") return [];

  try {
    const stored = localStorage.getItem(`${MANUAL_ITEMS_KEY}:${menuScopeKey}`);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ManualShoppingItem =>
        typeof item === "object" &&
        item !== null &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.amount === "number" &&
        typeof item.unit === "string"
    );
  } catch {
    return [];
  }
};

const loadPantryItemsFromStorage = (): PantryItem[] => {
  if (typeof window === "undefined") return [];

  try {
    const stored = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const loadPurchasedItemsForRange = (weeks: number, menuScopeKey = "default"): Record<string, boolean> => {
  if (typeof window === "undefined") return {};

  const weekStart = ensureWeekStart();
  const purchasedKey = `purchasedItems:${weekStart}:${weeks}:${menuScopeKey}`;
  const stored = localStorage.getItem(purchasedKey);
  if (!stored) return {};

  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // ignore parse errors
  }

  return {};
};

const readGuestReminderState = (): { show: boolean; strong: boolean } => {
  if (typeof window === "undefined") return { show: false, strong: false };

  const pending = window.sessionStorage.getItem(GUEST_REMINDER_PENDING_KEY) === "1";
  if (!pending) return { show: false, strong: false };

  window.sessionStorage.removeItem(GUEST_REMINDER_PENDING_KEY);

  let recipeCount = 0;
  try {
    const storedRecipes = localStorage.getItem(RECIPES_STORAGE_KEY);
    if (storedRecipes) {
      const parsed = JSON.parse(storedRecipes);
      if (Array.isArray(parsed)) recipeCount = parsed.length;
    }
  } catch {
    // ignore corrupted cache
  }

  return {
    show: true,
    strong: shouldUseStrongGuestReminder(recipeCount),
  };
};

const readGuestCounter = (key: string): number => {
  if (typeof window === "undefined") return 0;
  const parsed = Number(localStorage.getItem(key) || "0");
  return Number.isFinite(parsed) ? parsed : 0;
};

const shouldUseStrongGuestReminder = (recipesCount: number): boolean => {
  if (typeof window === "undefined") return false;
  const visits = readGuestCounter(GUEST_REMINDER_VISITS_KEY);
  const periodAttempts = readGuestCounter(GUEST_REMINDER_PERIOD_ATTEMPTS_KEY);
  return (
    visits >= GUEST_REMINDER_VISITS_THRESHOLD ||
    recipesCount > GUEST_REMINDER_RECIPES_THRESHOLD ||
    periodAttempts > 0
  );
};

const getDefaultShoppingSettings = (initialMergeMenus: boolean): ShoppingListSettings => ({
  includeCookedDishes: false,
  mergeMenus: initialMergeMenus,
  defaultDatePreset: "period",
  groupByCategories: true,
});

const loadShoppingSettings = (initialMergeMenus: boolean): ShoppingListSettings => {
  if (typeof window === "undefined") return getDefaultShoppingSettings(initialMergeMenus);
  const fallback = getDefaultShoppingSettings(initialMergeMenus);
  try {
    const raw = localStorage.getItem(SHOPPING_SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ShoppingListSettings>;
    const defaultDatePreset =
      parsed.defaultDatePreset === "today" || parsed.defaultDatePreset === "tomorrow" || parsed.defaultDatePreset === "period"
        ? parsed.defaultDatePreset
        : fallback.defaultDatePreset;
    return {
      includeCookedDishes: parsed.includeCookedDishes === true,
      mergeMenus: typeof parsed.mergeMenus === "boolean" ? parsed.mergeMenus : fallback.mergeMenus,
      defaultDatePreset,
      groupByCategories: parsed.groupByCategories !== false,
    };
  } catch {
    return fallback;
  }
};

const resolvePresetSelection = (
  weeks: number,
  preset: ShoppingListSettings["defaultDatePreset"]
): { preset: QuickDatePreset; dates: string[] } => {
  const availableDates = buildPeriodDates(ensureWeekStart(), weeks);
  const todayIso = formatDate(new Date());
  const tomorrowIso = formatDate(addDays(new Date(), 1));

  if (preset === "today" || preset === "tomorrow") {
    const target = preset === "today" ? todayIso : tomorrowIso;
    if (availableDates.includes(target)) {
      return { preset, dates: [target] };
    }
  }

  return { preset: "period", dates: availableDates };
};

const roundAmount = (value: number): number => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

const formatAmount = (value: number, locale: string): string => {
  const localeMap: Record<string, string> = {
    ru: "ru-RU",
    en: "en-US",
    es: "es-ES",
  };
  return new Intl.NumberFormat(localeMap[locale] || "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(roundAmount(value));
};

export default function ShoppingListPage() {
  const { locale, t } = useI18n();
  const activeLocale = resolveIntlLocale(locale);
  const [profileGoal, setProfileGoal] = useState<ProfileGoal>("menu");
  const [shoppingSelectedMenuId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem(SHOPPING_SELECTED_MENU_ID_KEY) || "";
  });
  const [shoppingSelectedMenuName] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem(SHOPPING_SELECTED_MENU_NAME_KEY) || "";
  });
  const [initialMergeMenus] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(SHOPPING_USE_MERGED_MENUS_KEY) === "1";
  });
  const [shoppingSettings, setShoppingSettings] = useState<ShoppingListSettings>(() =>
    loadShoppingSettings(initialMergeMenus)
  );

  const shoppingScopeKey = useMemo(
    () => (shoppingSettings.mergeMenus ? "merged" : shoppingSelectedMenuId || "default"),
    [shoppingSelectedMenuId, shoppingSettings.mergeMenus]
  );

  const [pantryItems, setPantryItems] = useState<PantryItem[]>(() =>
    loadPantryItemsFromStorage()
  );
  const [rangeWeeks] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const stored = localStorage.getItem(SHOPPING_RANGE_KEY);
    return stored ? parseInt(stored, 10) : 1;
  });

  const initialPresetSelection = resolvePresetSelection(rangeWeeks, shoppingSettings.defaultDatePreset);
  const periodDates = useMemo(() => buildPeriodDates(ensureWeekStart(), rangeWeeks), [rangeWeeks]);
  const [selectedDates, setSelectedDates] = useState<string[]>(initialPresetSelection.dates);
  const [activeDatePreset, setActiveDatePreset] = useState<QuickDatePreset>(initialPresetSelection.preset);
  const [isShoppingSettingsOpen, setIsShoppingSettingsOpen] = useState(false);

  const [showMenuAddedHint] = useState(() => {
    if (typeof window === "undefined") return false;
    const fromMenuAdded = window.sessionStorage.getItem("shoppingFromMenuAdded") === "1";
    if (fromMenuAdded) window.sessionStorage.removeItem("shoppingFromMenuAdded");
    return fromMenuAdded;
  });
  const [showShoppingUpdatedHint] = useState(() => {
    if (typeof window === "undefined") return false;
    const updated = window.sessionStorage.getItem("shoppingListUpdatedFromMenu") === "1";
    if (updated) window.sessionStorage.removeItem("shoppingListUpdatedFromMenu");
    return updated;
  });
  const guestReminderState = useMemo(() => readGuestReminderState(), []);
  const [showGuestReminder, setShowGuestReminder] = useState(guestReminderState.show);
  const guestReminderStrong = guestReminderState.strong;

  const [purchasedItems, setPurchasedItems] = useState<Record<string, boolean>>(() =>
    loadPurchasedItemsForRange(rangeWeeks, shoppingScopeKey)
  );

  const [manualItems, setManualItems] = useState<ManualShoppingItem[]>(() =>
    loadManualItemsFromStorage(shoppingScopeKey)
  );
  const shoppingSourceLabel = shoppingSettings.mergeMenus
    ? t("shopping.source.merged")
    : shoppingSelectedMenuName
      ? t("shopping.source.selectedMenu", { name: shoppingSelectedMenuName })
      : t("shopping.source.currentMenu");
  const [collapsedSections, setCollapsedSections] = useState<string[]>([]);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualUnit, setManualUnit] = useState("");
  const updateShoppingSettings = (patch: Partial<ShoppingListSettings>) => {
    setShoppingSettings((prev) => ({ ...prev, ...patch }));
  };

  // сохраняем rangeWeeks
  useEffect(() => {
    localStorage.setItem(SHOPPING_RANGE_KEY, rangeWeeks.toString());
  }, [rangeWeeks]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(SHOPPING_SETTINGS_KEY, JSON.stringify(shoppingSettings));
    window.sessionStorage.setItem(
      SHOPPING_USE_MERGED_MENUS_KEY,
      shoppingSettings.mergeMenus ? "1" : "0"
    );
  }, [shoppingSettings]);

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

  // сохраняем purchasedItems
  useEffect(() => {
    if (typeof window === "undefined") return;
    const weekStart = ensureWeekStart();
    const purchasedKey = `purchasedItems:${weekStart}:${rangeWeeks}:${shoppingScopeKey}`;
    localStorage.setItem(purchasedKey, JSON.stringify(purchasedItems));
  }, [purchasedItems, rangeWeeks, shoppingScopeKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(`${MANUAL_ITEMS_KEY}:${shoppingScopeKey}`, JSON.stringify(manualItems));
  }, [manualItems, shoppingScopeKey]);

  const shoppingList = useMemo(() => {
    if (typeof window === "undefined") return [];

    const weekStart = ensureWeekStart();
    const storedRecipes = localStorage.getItem(RECIPES_STORAGE_KEY);

    try {
      const recipes: Recipe[] = (() => {
        if (!storedRecipes) return [];
        try {
          const parsed = JSON.parse(storedRecipes);
          return Array.isArray(parsed) ? (parsed as Recipe[]) : [];
        } catch {
          return [];
        }
      })();
      const allIngredients: Ingredient[] = [];
      const menuBuckets: Array<{
        menuData: Record<string, MenuItem[]>;
        cellPeopleCountMap: Record<string, number>;
        cookedStatusMap: Record<string, boolean>;
      }> = [];
      const periodDaysForList = buildPeriodDates(weekStart, rangeWeeks);
      const effectiveDays =
        selectedDates.length > 0 ? selectedDates : periodDaysForList;
      const activeDaySet = new Set(effectiveDays);
      const isCountableIngredient = (ing: Ingredient): boolean => {
        const rawUnit = String(ing.unit || "").trim();
        const unitToken = ing.unitId || ing.unit_id || rawUnit;
        if (!ing.name || !ing.name.trim()) return false;
        if (!rawUnit && !ing.unitId && !ing.unit_id) return false;
        if (isTasteLikeUnit(unitToken)) return false;
        return Number.isFinite(ing.amount) && ing.amount > 0;
      };

      // 1) Preferred source: current selected period from Menu page (range key start__end)
      const storedRangeState = localStorage.getItem(RANGE_STATE_KEY);
      if (storedRangeState) {
        try {
          const parsed = JSON.parse(storedRangeState) as { start?: string; end?: string };
          if (parsed?.start && parsed?.end && isIsoDate(parsed.start) && isIsoDate(parsed.end)) {
            const suffix = `${parsed.start}__${parsed.end}`;
            const rangeMenuRaw = localStorage.getItem(`${MENU_STORAGE_KEY}:${suffix}`);
            if (rangeMenuRaw) {
              const fallbackCounts = normalizePeopleCountMap(
                JSON.parse(localStorage.getItem(`cellPeopleCount:${suffix}`) || "{}")
              );
              const fallbackCooked = normalizeCookedStatusMap(
                JSON.parse(localStorage.getItem(`cookedStatus:${suffix}`) || "{}")
              );
              const profiles = parseMenuProfilesFromRangeStorage(
                rangeMenuRaw,
                fallbackCounts,
                fallbackCooked
              );
              if (profiles.length > 0) {
                const scopedProfiles = shoppingSettings.mergeMenus
                  ? profiles
                  : shoppingSelectedMenuId
                    ? profiles.filter((menu) => menu.id === shoppingSelectedMenuId)
                    : [profiles[0]];
                const effectiveProfiles =
                  scopedProfiles.length > 0 ? scopedProfiles : [profiles[0]];
                effectiveProfiles.forEach((profile) => {
                  menuBuckets.push({
                    menuData: profile.mealData,
                    cellPeopleCountMap: profile.cellPeopleCount,
                    cookedStatusMap: profile.cookedStatus,
                  });
                });
              }
            }
          }
        } catch {
          // ignore corrupted range state
        }
      }

      // 2) Fallback: legacy weekly keys for selected number of weeks
      if (menuBuckets.length === 0) {
        for (let i = 0; i < rangeWeeks; i++) {
          const currentWeekDate = new Date(weekStart);
          currentWeekDate.setDate(currentWeekDate.getDate() + i * 7);
          const currentWeekKey = formatDate(currentWeekDate);

          const menuStorageKey = `${MENU_STORAGE_KEY}:${currentWeekKey}`;

          const storedMenu = localStorage.getItem(menuStorageKey);
          if (!storedMenu) continue;

          let fallbackCounts: Record<string, number> = {};
          let fallbackCooked: Record<string, boolean> = {};
          try {
            fallbackCounts = normalizePeopleCountMap(
              JSON.parse(localStorage.getItem(`cellPeopleCount:${currentWeekKey}`) || "{}")
            );
            fallbackCooked = normalizeCookedStatusMap(
              JSON.parse(localStorage.getItem(`cookedStatus:${currentWeekKey}`) || "{}")
            );
          } catch {
            fallbackCounts = {};
            fallbackCooked = {};
          }
          const profiles = parseMenuProfilesFromRangeStorage(storedMenu, fallbackCounts, fallbackCooked);
          const scopedProfiles = shoppingSettings.mergeMenus
            ? profiles
            : shoppingSelectedMenuId
              ? profiles.filter((menu) => menu.id === shoppingSelectedMenuId)
              : [profiles[0]];
          const effectiveProfiles = scopedProfiles.length > 0 ? scopedProfiles : [profiles[0]];
          effectiveProfiles.forEach((profile) => {
            menuBuckets.push({
              menuData: profile.mealData,
              cellPeopleCountMap: profile.cellPeopleCount,
              cookedStatusMap: profile.cookedStatus,
            });
          });
        }
      }

      menuBuckets.forEach(({ menuData, cellPeopleCountMap, cookedStatusMap }) => {
        Object.entries(menuData).forEach(([menuKey, menuItems]) => {
          const dayKey = menuKey.substring(0, 10);
          if (activeDaySet.size > 0 && !activeDaySet.has(dayKey)) {
            return;
          }
          menuItems.forEach((menuItem) => {
            const cookedFromMap = Boolean(menuItem.id && cookedStatusMap[menuItem.id]);
            const isCooked = menuItem.cooked === true || cookedFromMap;
            if (!shoppingSettings.includeCookedDishes && isCooked) {
              return;
            }

            if (menuItem.type === "recipe" && menuItem.recipeId) {
              if (menuItem.ingredients?.length) {
                menuItem.ingredients.forEach((ing) => {
                  if (isCountableIngredient(ing)) {
                    allIngredients.push({
                      ingredientId: ing.ingredientId,
                      unitId: ing.unitId,
                      name: ing.name,
                      unit: ing.unit,
                      amount: ing.amount,
                    });
                  }
                });
              } else {
                const recipe = recipes.find((r) => r.id === menuItem.recipeId);
                if (!recipe?.ingredients?.length) return;

                const peopleCount = cellPeopleCountMap[menuKey] || 1;
                const baseServings = recipe.servings && recipe.servings > 0 ? recipe.servings : 2;
                const scale = peopleCount / baseServings;

                recipe.ingredients.forEach((ing) => {
                  if (isCountableIngredient(ing)) {
                    allIngredients.push({
                      ingredientId: ing.ingredientId,
                      unitId: ing.unitId,
                      name: ing.name,
                      unit: ing.unit,
                      amount: ing.amount * scale,
                    });
                  }
                });
              }
            }

            if (menuItem.type === "text" && menuItem.includeInShopping && menuItem.ingredients) {
              menuItem.ingredients.forEach((ing) => {
                if (isCountableIngredient(ing)) {
                  allIngredients.push({
                    ingredientId: ing.ingredientId,
                    unitId: ing.unitId,
                    name: ing.name,
                    unit: ing.unit,
                    amount: ing.amount,
                  });
                }
              });
            }
          });
        });
      });

      // group
      const ingredientGroups: Record<
        string,
        { totalAmount: number; unit: string; unitId?: UnitId; name: string; ingredientId?: string }
      > = {};

      allIngredients.forEach((ing) => {
        const resolvedId = resolveIngredientId(ing);
        const resolvedUnitId = tryNormalizeUnitId(ing.unitId || ing.unit_id || ing.unit || "");
        const unitKey = resolvedUnitId ? `id:${resolvedUnitId}` : `txt:${normalizeString(ing.unit)}`;
        const key = resolvedId
          ? `id:${resolvedId}|${unitKey}`
          : normalizeKey(ing.name, ing.unit, resolvedUnitId || undefined);
        if (!ingredientGroups[key]) {
          ingredientGroups[key] = {
            totalAmount: 0,
            unit: ing.unit,
            unitId: resolvedUnitId || undefined,
            name: resolvedId ? getIngredientNameById(resolvedId, locale, ing.name) : ing.name,
            ingredientId: resolvedId || undefined,
          };
        }
        ingredientGroups[key].totalAmount += ing.amount;
      });

      const groupedList: GroupedIngredient[] = Object.entries(ingredientGroups)
        .map(([, data]) => {
          const normalizedName = data.name.trim();
          return {
            name: normalizedName.charAt(0).toUpperCase() + normalizedName.slice(1),
            totalAmount: data.totalAmount,
            unit: data.unit,
            unitId: data.unitId,
            ingredientId: data.ingredientId,
            category: categorizeIngredient({
              ingredientId: data.ingredientId,
              unitId: data.unitId,
              name: data.name,
              amount: data.totalAmount,
              unit: data.unit,
            }),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, activeLocale, { sensitivity: "base" }));

      return groupedList;
    } catch (error) {
      console.error("Failed to generate shopping list:", error);
      return [];
    }
  }, [activeLocale, locale, rangeWeeks, selectedDates, shoppingSelectedMenuId, shoppingSettings.includeCookedDishes, shoppingSettings.mergeMenus]);

  // сохраняем pantryItems
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(pantryItems));
  }, [pantryItems]);

  const getRemainingAmount = (name: string, unit: string, requiredAmount: number, unitId?: UnitId) => {
    const normalizedIngredientName = name.toLowerCase().trim();
    const normalizedUnitKey = getUnitStorageKey(unit, unitId);
    const pantryItem = pantryItems.find(item => 
      item.name.toLowerCase().trim() === normalizedIngredientName && 
      getUnitStorageKey(item.unit) === normalizedUnitKey
    );
    const haveAmount = pantryItem?.amount || 0;
    return Math.max(0, requiredAmount - haveAmount);
  };

  const isPurchased = (name: string, unit: string, unitId?: UnitId) => {
    const key = normalizeKey(name, unit, unitId);
    if (purchasedItems[key]) return true;
    const legacyKey = `${normalizeString(name)}|${normalizeString(unit)}`;
    return purchasedItems[legacyKey] || false;
  };

  const togglePurchasedItem = (name: string, unit: string, unitId?: UnitId) => {
    const key = normalizeKey(name, unit, unitId);
    const wasPurchased = purchasedItems[key] || false;
    const isNowPurchased = !wasPurchased;
    
    setPurchasedItems((prev) => ({ ...prev, [key]: isNowPurchased }));
    
    // Add to pantry when item is marked as purchased
    if (isNowPurchased) {
      // Find the ingredient amount from the shopping list
      const item = shoppingList.find(item => 
        normalizeKey(item.name, item.unit, item.unitId) === key
      );
      
      if (item) {
        appendProductSuggestions([item.name]);

        setPantryItems(prev => {
          const normalizedIngredientName = item.name.toLowerCase().trim();
          const normalizedUnitKey = getUnitStorageKey(item.unit, item.unitId);
          const existingIndex = prev.findIndex(pantryItem => 
            pantryItem.name.toLowerCase().trim() === normalizedIngredientName && 
            getUnitStorageKey(pantryItem.unit) === normalizedUnitKey
          );

          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = {
              ...updated[existingIndex],
              amount: updated[existingIndex].amount + item.totalAmount
            };
            return updated;
          }

          return [...prev, { 
            name: item.name, 
            amount: item.totalAmount,
            unit: item.unit 
          }];
        });
      }
    }
  };

  const handleAddManualItem = () => {
    const trimmedName = manualName.trim();
    if (!trimmedName) return;

    const parsedAmount = parseFloat(manualAmount);
    const amount = Number.isFinite(parsedAmount) ? parsedAmount : 0;

    const nextItem: ManualShoppingItem = {
      id: `manual-${Date.now()}`,
      name: trimmedName,
      amount,
      unit: manualUnit.trim(),
    };

    setManualItems((prev) => [...prev, nextItem]);
    setManualName("");
    setManualAmount("");
    setManualUnit("");
    setIsManualModalOpen(false);
  };

  const manualListItems: GroupedIngredient[] = manualItems.map((manual) => ({
    name: manual.name,
    totalAmount: manual.amount,
    unit: manual.unit,
    category: "other",
    id: manual.id,
    isManual: true,
  }));

  const filterUnpurchased = (items: GroupedIngredient[]) =>
    items.filter((item) => {
      const remaining = getRemainingAmount(item.name, item.unit, item.totalAmount, item.unitId);
      if (isPurchased(item.name, item.unit, item.unitId)) return false;
      return remaining > 0;
    });

  const filterPurchased = (items: GroupedIngredient[]) =>
    items.filter((item) => isPurchased(item.name, item.unit, item.unitId));

  const filteredMenuUnpurchased = filterUnpurchased(shoppingList);
  const filteredMenuPurchased = filterPurchased(shoppingList);

  const filteredManualUnpurchased = filterUnpurchased(manualListItems);
  const filteredManualPurchased = filterPurchased(manualListItems);

  const combinedUnpurchasedList = [...filteredMenuUnpurchased, ...filteredManualUnpurchased];
  const combinedPurchasedList = [...filteredMenuPurchased, ...filteredManualPurchased];
  const categorySections = STORE_CATEGORY_ORDER
    .map((category) => {
      const itemsInCategory = [
        ...filteredMenuUnpurchased.filter((item) => item.category === category),
        ...filteredMenuPurchased.filter((item) => item.category === category),
      ];
      return { category, items: itemsInCategory };
    })
    .filter((section) => section.items.length > 0);

  const manualSectionItems = [...filteredManualUnpurchased, ...filteredManualPurchased];
  const flatVisibleItems = [...combinedUnpurchasedList, ...combinedPurchasedList];

  const manualSectionLabel = t("shopping.manualSection");
  const getCategoryLabel = (category: StoreCategoryId): string => {
    if (category === "vegetables") return t("shopping.categories.vegetables");
    if (category === "meat") return t("shopping.categories.meat");
    if (category === "dairy") return t("shopping.categories.dairy");
    if (category === "grocery") return t("shopping.categories.grocery");
    return t("shopping.categories.other");
  };
  const toggleSectionCollapse = (section: string) => {
    setCollapsedSections((prev) =>
      prev.includes(section) ? prev.filter((name) => name !== section) : [...prev, section]
    );
  };

  const isSectionCollapsed = (section: string) => collapsedSections.includes(section);

  const renderShoppingItem = (item: GroupedIngredient) => {
    const remainingAmount = getRemainingAmount(item.name, item.unit, item.totalAmount, item.unitId);
    const haveEnough = remainingAmount <= 0;
    const purchased = isPurchased(item.name, item.unit, item.unitId);
    const localizedUnit = getUnitLabel(item.unitId || item.unit, locale, item.unit);

    return (
      <div
        key={item.id ?? `${item.name}-${item.unitId || item.unit}`}
        className={`shopping-list_item ${haveEnough ? "shopping-list_item--have" : ""} ${
          purchased ? "shopping-list__item--purchased" : ""
        }`}
      >
        <div className="shopping-list__main">
          <span className="shopping-list__dish-name">{item.name}</span>

          <div className="shopping-list__amounts">
            <span
              className={`shopping-list__buy ${
                haveEnough ? "shopping-list__buy--enough" : ""
              }`}
            >
              {t("shopping.buyAmount", { amount: formatAmount(remainingAmount, locale) })} {localizedUnit}
            </span>
          </div>
        </div>

        <div className="shopping-list__purchased">
          <button
            type="button"
            className={`shopping-list__purchased-btn ${
              purchased ? "shopping-list__purchased-btn--active" : ""
            }`}
            onClick={() => togglePurchasedItem(item.name, item.unit, item.unitId)}
            aria-pressed={purchased}
            aria-label={
              purchased
                ? t("shopping.actions.unmarkPurchasedAria", { name: item.name })
                : t("shopping.actions.markPurchasedAria", { name: item.name })
            }
          >
            {t("shopping.actions.purchased")}
          </button>
        </div>

      </div>
    );
  };

  const buildPrintItem = (item: GroupedIngredient): ShoppingPrintItem => {
    const remainingAmount = getRemainingAmount(item.name, item.unit, item.totalAmount, item.unitId);
    const localizedUnit = getUnitLabel(item.unitId || item.unit, locale, item.unit);
    return {
      id: String(item.id ?? `${item.name}-${item.unitId || item.unit}`),
      name: item.name,
      amountLabel: `${formatAmount(remainingAmount, locale)} ${localizedUnit}`.trim(),
      purchased: isPurchased(item.name, item.unit, item.unitId),
    };
  };

  const buildPrintSections = (): ShoppingPrintSection[] => {
    if (shoppingSettings.groupByCategories) {
      const categorized: ShoppingPrintSection[] = categorySections
        .map((section) => ({
          id: section.category,
          title: getCategoryLabel(section.category),
          items: section.items.map(buildPrintItem),
        }))
        .filter((section) => section.items.length > 0);

      const manualItemsForPrint = manualSectionItems.map(buildPrintItem);
      if (manualItemsForPrint.length > 0) {
        categorized.push({
          id: "manual",
          title: manualSectionLabel,
          items: manualItemsForPrint,
        });
      }
      return categorized;
    }

    return [
      {
        id: "all",
        title: t("shopping.title"),
        items: flatVisibleItems.map(buildPrintItem),
      },
    ].filter((section) => section.items.length > 0);
  };

  const buildPrintPeriodLabel = (): string => {
    if (activeDatePreset === "today") return t("shopping.period.today");
    if (activeDatePreset === "tomorrow") return t("shopping.period.tomorrow");
    return t("shopping.period.full");
  };

  const openPrintVersion = () => {
    if (typeof window === "undefined") return;
    const snapshot: ShoppingPrintSnapshot = {
      title: t("shopping.title"),
      periodLabel: buildPrintPeriodLabel(),
      sourceLabel: shoppingSourceLabel,
      generatedAt: new Date().toISOString(),
      sections: buildPrintSections(),
    };
    window.sessionStorage.setItem(SHOPPING_PRINT_SNAPSHOT_KEY, JSON.stringify(snapshot));
    window.open("/shopping-list/print", "_blank", "noopener,noreferrer");
  };

  const todayIso = formatDate(new Date());
  const tomorrowIso = formatDate(addDays(new Date(), 1));
  const getEffectivePeriodDates = (): string[] =>
    periodDates.length > 0
      ? periodDates
      : buildPeriodDates(ensureWeekStart(), rangeWeeks);

  const handleQuickDatePreset = (preset: QuickDatePreset) => {
    const availableDates = getEffectivePeriodDates();
    let nextSelection: string[] = [];
    let resolvedPreset = preset;

    if (preset === "today" || preset === "tomorrow") {
      const target = preset === "today" ? todayIso : tomorrowIso;
      if (availableDates.includes(target)) {
        nextSelection = [target];
      } else {
        nextSelection = availableDates;
        resolvedPreset = "period";
      }
    } else {
      nextSelection = availableDates;
    }

    setActiveDatePreset(resolvedPreset);
    setSelectedDates(nextSelection);
  };

  return (
    <section className="card">
      <div className="shopping-list__header">
        <h1 className="h1">{t("shopping.title")}</h1>

        <div className="shopping-list__date-filter">
          <div className="shopping-list__quick-buttons">
            <button
              type="button"
              className={`shopping-list__quick-btn ${
                activeDatePreset === "today" ? "shopping-list__quick-btn--active" : ""
              }`}
              onClick={() => handleQuickDatePreset("today")}
            >
              {t("shopping.period.today")}
            </button>
            <button
              type="button"
              className={`shopping-list__quick-btn ${
                activeDatePreset === "tomorrow" ? "shopping-list__quick-btn--active" : ""
              }`}
              onClick={() => handleQuickDatePreset("tomorrow")}
            >
              {t("shopping.period.tomorrow")}
            </button>
            <button
              type="button"
              className={`shopping-list__quick-btn ${
                activeDatePreset === "period" ? "shopping-list__quick-btn--active" : ""
              }`}
              onClick={() => handleQuickDatePreset("period")}
            >
              {t("shopping.period.full")}
            </button>
          </div>

          <button
            type="button"
            className="shopping-list__add-manual-btn"
            onClick={() => setIsManualModalOpen(true)}
          >
            {t("shopping.actions.addManual")}
          </button>

          <button
            type="button"
            className="shopping-list__add-manual-btn"
            onClick={openPrintVersion}
          >
            {t("shopping.actions.printVersion")}
          </button>

          <button
            type="button"
            className="shopping-list__custom-days-btn"
            onClick={() => setIsShoppingSettingsOpen(true)}
            title={t("shopping.settings.title")}
            aria-label={t("shopping.settings.title")}
          >
            ⚙
          </button>
        </div>

        {profileGoal === "shopping" ? (
          <div className="card" style={{ marginTop: "10px", padding: "10px 12px" }}>
            <p className="muted" style={{ margin: "0 0 8px 0" }}>
              {t("shopping.goalHints.quickStart")}
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setIsManualModalOpen(true)}>
              {t("shopping.goalHints.quickAction")}
            </button>
          </div>
        ) : null}

        {showMenuAddedHint && (
          <p className="muted" style={{ marginTop: "8px", marginBottom: 0, fontSize: "13px" }}>
            {t("shopping.hints.menuIngredientsAdded")}
          </p>
        )}
        {showShoppingUpdatedHint && (
          <p className="muted" style={{ marginTop: "8px", marginBottom: 0, fontSize: "13px" }}>
            {t("shopping.hints.listUpdated")}
          </p>
        )}

        {showGuestReminder && (
          <div className="card" style={{ marginTop: "10px", padding: "10px 12px" }}>
            <img
              src="/mascot/pages/auth.png"
              alt=""
              aria-hidden="true"
              style={{ width: "64px", height: "64px", objectFit: "contain", marginBottom: "6px" }}
            />
            <p style={{ margin: 0, fontWeight: 700 }}>
              {guestReminderStrong
                ? t("shopping.guestReminder.strong")
                : t("shopping.guestReminder.normal")}
            </p>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px", marginTop: "8px" }}>
              <Link href="/auth" className="btn btn-primary" onClick={() => setShowGuestReminder(false)}>
                {t("shopping.guestReminder.createAccount")}
              </Link>
              <button
                type="button"
                className="menu-first-onboarding__skip"
                style={{ fontSize: "12px" }}
                onClick={() => setShowGuestReminder(false)}
              >
                {t("shopping.guestReminder.later")}
              </button>
            </div>
          </div>
        )}

      </div>

      {shoppingList.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__title">{t("shopping.empty.title")}</div>
          <div className="empty-state__description">
            {t("shopping.empty.description1")}
          </div>
          <div className="empty-state__description">
            {t("shopping.empty.description2")}
          </div>
          <div className="empty-state__description">{t("shopping.empty.example")}</div>
          <div style={{ marginTop: "16px", display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
            {profileGoal === "shopping" ? (
              <button type="button" className="btn btn-primary" onClick={() => setIsManualModalOpen(true)}>
                {t("shopping.goalHints.quickAction")}
              </button>
            ) : (
              <Link href="/menu" className="btn btn-primary">
                {t("shopping.actions.buildMenu")}
              </Link>
            )}
            <Link href="/recipes/new" className="btn btn-add">
              {t("shopping.actions.addRecipe")}
            </Link>
            {profileGoal === "shopping" ? (
              <Link href="/menu" className="btn">
                {t("shopping.actions.buildMenu")}
              </Link>
            ) : null}
          </div>
          <div style={{ marginTop: "12px", fontSize: "13px", color: "var(--text-tertiary)" }}>
            {t("shopping.empty.footer")}
          </div>
        </div>
      ) : (
        <div>
          <div className="shopping-list">
            {flatVisibleItems.length === 0 ? (
              <p className="muted shopping-list__empty-filter">
                {t("shopping.empty.filtered")}
              </p>
            ) : (
              <>
                {shoppingSettings.groupByCategories ? (
                  <>
                    {categorySections.map((section) => {
                      const sectionCollapsed = isSectionCollapsed(section.category);
                      return (
                        <div key={section.category} className="shopping-list__category-section">
                          <div className="shopping-list__category-heading">
                            <button
                              type="button"
                              className="shopping-list__category-toggle"
                              onClick={() => toggleSectionCollapse(section.category)}
                              aria-expanded={!sectionCollapsed}
                            >
                              <span className="shopping-list__category-heading-label">
                                {getCategoryLabel(section.category)}
                              </span>
                              <span className="shopping-list__category-count">
                                {t("shopping.positionsCount", { count: section.items.length })}
                              </span>
                              <span className="shopping-list__category-chevron" aria-hidden="true">
                                {sectionCollapsed ? "+" : "-"}
                              </span>
                            </button>
                          </div>
                          {!sectionCollapsed && section.items.map((item) => renderShoppingItem(item))}
                        </div>
                      );
                    })}
                    {manualSectionItems.length > 0 && (
                      <div className="shopping-list__manual-group">
                        <div className="shopping-list__manual-heading">
                          <button
                            type="button"
                            className="shopping-list__manual-toggle"
                            onClick={() => toggleSectionCollapse(manualSectionLabel)}
                            aria-expanded={!isSectionCollapsed(manualSectionLabel)}
                          >
                            <span className="shopping-list__category-heading-label">
                              {manualSectionLabel}
                            </span>
                            <span className="shopping-list__category-count">
                              {t("shopping.positionsCount", { count: manualSectionItems.length })}
                            </span>
                            <span className="shopping-list__category-chevron" aria-hidden="true">
                              {isSectionCollapsed(manualSectionLabel) ? "+" : "-"}
                            </span>
                          </button>
                        </div>
                        {!isSectionCollapsed(manualSectionLabel) &&
                          manualSectionItems.map((item) => renderShoppingItem(item))}
                      </div>
                    )}
                  </>
                ) : (
                  flatVisibleItems.map((item) => renderShoppingItem(item))
                )}
              </>
            )}
          </div>

          <div className="shopping-list__actions">
            <Link href="/menu" className="shopping-list__link">
              {t("shopping.actions.backToMenu")}
            </Link>
          </div>
        </div>
      )}
      {isShoppingSettingsOpen && (
        <div className="menu-dialog-overlay" role="dialog" aria-modal="true" aria-label={t("shopping.settings.title")}>
          <div className="menu-dialog" style={{ maxWidth: "460px" }}>
            <h3 style={{ marginTop: 0, marginBottom: "10px" }}>{t("shopping.settings.title")}</h3>
            <p className="muted" style={{ marginBottom: "12px", fontSize: "13px" }}>
              {shoppingSourceLabel}
            </p>

            <div style={{ display: "grid", gap: "10px" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
                <input
                  type="checkbox"
                  checked={shoppingSettings.includeCookedDishes}
                  onChange={(e) => updateShoppingSettings({ includeCookedDishes: e.target.checked })}
                />
                {t("shopping.settings.includeCooked")}
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
                <input
                  type="checkbox"
                  checked={shoppingSettings.mergeMenus}
                  onChange={(e) => {
                    const nextMergeMenus = e.target.checked;
                    const nextScopeKey = nextMergeMenus ? "merged" : shoppingSelectedMenuId || "default";
                    updateShoppingSettings({ mergeMenus: nextMergeMenus });
                    setPurchasedItems(loadPurchasedItemsForRange(rangeWeeks, nextScopeKey));
                    setManualItems(loadManualItemsFromStorage(nextScopeKey));
                  }}
                />
                {t("shopping.settings.mergeMenus")}
              </label>

              <label style={{ display: "grid", gap: "6px", fontSize: "14px" }}>
                <span>{t("shopping.settings.defaultPeriod")}</span>
                <select
                  className="menu-dialog__select"
                  value={shoppingSettings.defaultDatePreset}
                  onChange={(e) => {
                    const preset = e.target.value as ShoppingListSettings["defaultDatePreset"];
                    updateShoppingSettings({ defaultDatePreset: preset });
                    handleQuickDatePreset(preset);
                  }}
                >
                  <option value="today">{t("shopping.period.today")}</option>
                  <option value="tomorrow">{t("shopping.period.tomorrow")}</option>
                  <option value="period">{t("shopping.period.full")}</option>
                </select>
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
                <input
                  type="checkbox"
                  checked={shoppingSettings.groupByCategories}
                  onChange={(e) => updateShoppingSettings({ groupByCategories: e.target.checked })}
                />
                {t("shopping.settings.groupByCategories")}
              </label>
            </div>

            <div className="menu-dialog__actions">
              <button type="button" className="menu-dialog__confirm" onClick={() => setIsShoppingSettingsOpen(false)}>
                {t("shopping.actions.done")}
              </button>
            </div>
          </div>
        </div>
      )}
      {isManualModalOpen && (
        <div className="shopping-list__manual-modal" role="dialog" aria-modal="true">
          <div className="shopping-list__manual-dialog card">
            <div className="shopping-list__manual-header">
              <span>{t("shopping.manualModal.title")}</span>
              <button
                type="button"
                className="shopping-list__manual-close"
                onClick={() => setIsManualModalOpen(false)}
                aria-label={t("shopping.manualModal.closeAria")}
              >
                ×
              </button>
            </div>

            <div className="shopping-list__manual-field">
              <label>{t("shopping.manualModal.nameLabel")}</label>
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder={t("shopping.manualModal.namePlaceholder")}
                className="shopping-list__manual-input"
                autoFocus
              />
            </div>

            <div className="shopping-list__manual-field">
              <label>{t("shopping.manualModal.amountLabel")}</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={manualAmount}
                onChange={(e) => setManualAmount(e.target.value)}
                placeholder="0"
                className="shopping-list__manual-input"
              />
            </div>

            <div className="shopping-list__manual-field">
              <label>{t("shopping.manualModal.unitLabel")}</label>
              <input
                type="text"
                value={manualUnit}
                onChange={(e) => setManualUnit(e.target.value)}
                placeholder={t("shopping.manualModal.unitPlaceholder")}
                className="shopping-list__manual-input"
              />
            </div>

            <div className="shopping-list__manual-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setIsManualModalOpen(false)}
              >
                {t("shopping.actions.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAddManualItem}
                disabled={!manualName.trim()}
              >
                {t("shopping.actions.add")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

