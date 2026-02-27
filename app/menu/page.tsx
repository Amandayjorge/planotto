"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import ProductAutocompleteInput from "../components/ProductAutocompleteInput";
import {
  STARTER_PRODUCT_SUGGESTIONS,
  appendProductSuggestions,
  loadProductSuggestions,
  sanitizeProductSuggestion,
} from "../lib/productSuggestions";
import { getMenuSuggestion } from "../lib/aiAssistantClient";
import { getCurrentUserId, listMyRecipes } from "../lib/recipesSupabase";
import { getSupabaseClient, isSupabaseConfigured } from "../lib/supabaseClient";
import {
  copyPublicWeekToMine,
  getMineWeekMenu,
  getPublicWeekMenuById,
  listPublicWeekSummaries,
  type MenuWeekVisibility,
  type PublicWeekSummary,
  upsertMineWeekMenu,
} from "../lib/weeklyMenusSupabase";
import { useI18n } from "../components/I18nProvider";
import { usePlanottoConfirm } from "../components/usePlanottoConfirm";
import { usePlanTier } from "../lib/usePlanTier";
import { isPaidFeatureEnabled } from "../lib/subscription";
import { downloadPdfExport, type PdfRecipePayload } from "../lib/pdfExportClient";
import { readProfileGoalFromStorage, type ProfileGoal } from "../lib/profileGoal";
import {
  DEFAULT_UNIT_ID,
  getUnitLabelById,
  isTasteLikeUnit,
  normalizeUnitId,
  tryNormalizeUnitId,
  type UnitId,
} from "../lib/ingredientUnits";

const MENU_STORAGE_KEY = "weeklyMenu";
const RECIPES_STORAGE_KEY = "recipes";
const CELL_PEOPLE_COUNT_KEY = "cellPeopleCount";
const RANGE_STATE_KEY = "selectedMenuRange";
const WEEK_START_KEY = "selectedWeekStart";
const PANTRY_STORAGE_KEY = "pantry";
const MENU_FIRST_VISIT_ONBOARDING_KEY = "menuFirstVisitOnboardingSeen";
const MENU_INLINE_HINT_DISMISSED_KEY = "menuInlineHintDismissed";
const RECIPES_FIRST_FLOW_KEY = "recipesFirstFlowActive";
const GUEST_REMINDER_VISITS_KEY = "guestReminderVisits";
const GUEST_REMINDER_PERIOD_ATTEMPTS_KEY = "guestReminderPeriodAttempts";
const GUEST_REMINDER_PENDING_KEY = "guestReminderPending";
const GUEST_REMINDER_VISITS_THRESHOLD = 3;
const GUEST_REMINDER_RECIPES_THRESHOLD = 3;
const ACTIVE_PRODUCTS_CLOUD_META_KEY = "planotto_active_products_v1";
const ACTIVE_PRODUCT_NOTE_MAX_LENGTH = 40;
const MENU_STORAGE_VERSION = 2;
const DEFAULT_MENU_NAME_FALLBACK = "Main";
const SYSTEM_MENU_NAME_ALIASES = new Set(["main", "основное", "principal"]);
const MENU_SHOPPING_MERGE_KEY_PREFIX = "menuShoppingMerge";
const MENU_ADD_TO_MENU_PROMPT_KEY = "menuAddToMenuPromptEnabled";
const MENU_PLANNING_DAYS_KEY_PREFIX = "menuPlanningDays";
const MENU_TWO_MEALS_MODE_KEY = "menuTwoMealsMode";
const MENU_DELETE_UNDO_TIMEOUT_MS = 5000;
const DAY_STRUCTURE_MODE_KEY = "menuDayStructureMode";
const MEAL_STRUCTURE_SETTINGS_KEY = "menuMealStructureSettings";
const MEAL_STRUCTURE_DEFAULT_SETTINGS_KEY = "menuMealStructureDefaults";
const DEFAULT_DAY_MEAL_KEYS = ["breakfast", "lunch", "dinner"] as const;
const DEFAULT_SNACK_MEAL_ID = "default-snack";
type MealType = (typeof DEFAULT_DAY_MEAL_KEYS)[number];
const MEAL_TYPE_INDEX: Record<MealType, number> = { breakfast: 0, lunch: 1, dinner: 2 };
const RECIPE_CATEGORY_FILTER_ALL = "__all__";
type DayStructureMode = "list" | "meals";
type PlanDaysPreference = "all" | "weekdays" | "weekends";
type MealsPerDayPreference = "1-2" | "3" | "4+" | "variable";
type TwoMealsMode = "breakfast_lunch" | "lunch_dinner" | "breakfast_dinner";

const normalizeMealAlias = (value: string): string =>
  value
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const DEFAULT_MEAL_ALIASES: Record<MealType, Set<string>> = {
  breakfast: new Set(["breakfast", "desayuno", "завтрак"]),
  lunch: new Set(["lunch", "comida", "almuerzo", "обед"]),
  dinner: new Set(["dinner", "cena", "ужин"]),
};

const resolveDefaultMealTypeByName = (value: string): MealType | null => {
  const normalized = normalizeMealAlias(value);
  if (!normalized) return null;
  for (const mealType of DEFAULT_DAY_MEAL_KEYS) {
    if (DEFAULT_MEAL_ALIASES[mealType].has(normalized)) {
      return mealType;
    }
  }
  return null;
};

const localizeDefaultMealSlots = (
  slots: MealSlotSetting[],
  defaultMealLabels: readonly string[],
  snackLabel: string
): MealSlotSetting[] =>
  slots.map((slot) => {
    if (slot.id === DEFAULT_SNACK_MEAL_ID) {
      if (slot.name === snackLabel) return slot;
      return { ...slot, name: snackLabel };
    }
    if (!slot.id.startsWith("default-")) return slot;
    const rawIndex = Number(slot.id.slice("default-".length));
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= DEFAULT_DAY_MEAL_KEYS.length) {
      return slot;
    }
    const expectedMealType = DEFAULT_DAY_MEAL_KEYS[rawIndex];
    const currentMealType = resolveDefaultMealTypeByName(slot.name);
    if (currentMealType !== expectedMealType) return slot;

    const localizedName = defaultMealLabels[MEAL_TYPE_INDEX[expectedMealType]] || slot.name;
    if (slot.name === localizedName) return slot;
    return { ...slot, name: localizedName };
  });

interface MealSlotSetting {
  id: string;
  name: string;
  visible: boolean;
  order: number;
}

const createDefaultMealSlots = (defaultMealLabels: readonly string[]): MealSlotSetting[] =>
  defaultMealLabels.map((name, index) => ({
    id: `default-${index}`,
    name,
    visible: true,
    order: index,
  }));

const normalizeMealsPerDayPreference = (value: unknown): MealsPerDayPreference => {
  if (value === "1-2") return "1-2";
  if (value === "4+") return "4+";
  if (value === "variable") return "variable";
  return "3";
};

const normalizeTwoMealsMode = (value: unknown): TwoMealsMode => {
  if (value === "lunch_dinner") return "lunch_dinner";
  if (value === "breakfast_dinner") return "breakfast_dinner";
  return "breakfast_lunch";
};

const buildMealSlotsByMealsPerDay = (
  defaultMealLabels: readonly string[],
  snackLabel: string,
  mealsPerDay: MealsPerDayPreference,
  twoMealsMode: TwoMealsMode
): MealSlotSetting[] => {
  const coreSlots = createDefaultMealSlots(defaultMealLabels);
  const snackSlot: MealSlotSetting = {
    id: DEFAULT_SNACK_MEAL_ID,
    name: snackLabel,
    visible: false,
    order: coreSlots.length,
  };
  const slots = [...coreSlots, snackSlot];

  if (mealsPerDay === "variable") {
    return slots.map((slot, index) => ({ ...slot, visible: true, order: index }));
  }
  if (mealsPerDay === "4+") {
    return slots.map((slot, index) => ({ ...slot, visible: true, order: index }));
  }
  if (mealsPerDay === "1-2") {
    const visibleIds =
      twoMealsMode === "lunch_dinner"
        ? new Set(["default-1", "default-2"])
        : twoMealsMode === "breakfast_dinner"
          ? new Set(["default-0", "default-2"])
          : new Set(["default-0", "default-1"]);
    return slots.map((slot, index) => ({
      ...slot,
      visible: visibleIds.has(slot.id),
      order: index,
    }));
  }

  return slots.map((slot, index) => ({
    ...slot,
    visible: slot.id !== DEFAULT_SNACK_MEAL_ID,
    order: index,
  }));
};

const normalizeMealSlotName = (value: string): string => value.trim().replace(/\s+/g, " ");
const normalizeMenuProfileName = (value: string): string => value.trim().replace(/\s+/g, " ");
const parseItemsList = (raw: string): string[] => {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const chunk of raw.split(/[,\n;]+/)) {
    const value = chunk.trim();
    if (!value) continue;
    const key = value
      .toLocaleLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}+/gu, "");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(value);
  }
  return items;
};

const resolveUserMetaValue = (
  metadata: Record<string, unknown> | undefined,
  key: string,
  fallback = ""
): string => {
  const raw = metadata?.[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return fallback;
};

const parseMealSlots = (raw: string | null): MealSlotSetting[] | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rows = parsed
      .map((item) => item as Partial<MealSlotSetting>)
      .filter((item) => typeof item.name === "string" && normalizeMealSlotName(item.name).length > 0)
      .map((item, index) => ({
        id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
        name: normalizeMealSlotName(String(item.name || "")),
        visible: item.visible !== false,
        order: Number.isFinite(item.order) ? Number(item.order) : index,
      }));
    if (rows.length === 0) return null;
    return rows.sort((a, b) => a.order - b.order).map((item, index) => ({ ...item, order: index }));
  } catch {
    return null;
  }
};

const loadDefaultMealSlotsFromStorage = (
  defaultMealLabels: readonly string[],
  snackLabel: string,
  mealsPerDay: MealsPerDayPreference,
  twoMealsMode: TwoMealsMode
): MealSlotSetting[] => {
  if (typeof window === "undefined") return createDefaultMealSlots(defaultMealLabels);
  const defaults = parseMealSlots(window.localStorage.getItem(MEAL_STRUCTURE_DEFAULT_SETTINGS_KEY));
  if (defaults) return localizeDefaultMealSlots(defaults, defaultMealLabels, snackLabel);

  // Backward compatibility with old single-key storage.
  const legacy = parseMealSlots(window.localStorage.getItem(MEAL_STRUCTURE_SETTINGS_KEY));
  if (legacy) return localizeDefaultMealSlots(legacy, defaultMealLabels, snackLabel);

  return buildMealSlotsByMealsPerDay(defaultMealLabels, snackLabel, mealsPerDay, twoMealsMode);
};

const loadMealSlotsFromStorage = (
  rangeKey: string,
  defaultMealLabels: readonly string[],
  snackLabel: string,
  mealsPerDay: MealsPerDayPreference,
  twoMealsMode: TwoMealsMode
): MealSlotSetting[] => {
  if (typeof window === "undefined") return createDefaultMealSlots(defaultMealLabels);
  const byRange = parseMealSlots(window.localStorage.getItem(`${MEAL_STRUCTURE_SETTINGS_KEY}:${rangeKey}`));
  if (byRange) return localizeDefaultMealSlots(byRange, defaultMealLabels, snackLabel);
  return loadDefaultMealSlotsFromStorage(defaultMealLabels, snackLabel, mealsPerDay, twoMealsMode);
};

const splitCellKey = (cellKey: string): { dayKey: string; mealLabel: string } | null => {
  const match = cellKey.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (!match) return null;
  return { dayKey: match[1], mealLabel: match[2] };
};

const INGREDIENT_UNIT_IDS: UnitId[] = ["g", "kg", "ml", "l", "pcs", "tsp", "tbsp", "to_taste"];
const DEFAULT_UNIT = getUnitLabelById(DEFAULT_UNIT_ID, "en");

interface Ingredient {
  id: string;
  name: string;
  amount: number;
  unit: string;
  unitId?: UnitId;
  unit_id?: UnitId;
}

interface PantryItem {
  name: string;
  amount: number;
  unit: string;
}

interface MenuItem {
  id: string;
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

interface Recipe {
  id: string;
  title: string;
  ingredients?: Ingredient[];
  shortDescription?: string;
  description?: string;
  instructions?: string;
  categories?: string[];
  tags?: string[];
  notes?: string;
  timesCooked?: number;
  servings?: number;
}

type ActiveProductScope = "in_period" | "persistent" | "until_date";

interface ActivePeriodProduct {
  id: string;
  name: string;
  scope: ActiveProductScope;
  untilDate: string;
  prefer: boolean;
  note: string;
  hidden: boolean;
}

const normalizeActiveProductScope = (value: unknown): ActiveProductScope => {
  if (value === "in_period" || value === "persistent" || value === "until_date") {
    return value;
  }
  // Backward compatibility for old scope values.
  if (value === "today" || value === "this_week") {
    return "in_period";
  }
  return "in_period";
};

const normalizeActivePeriodProducts = (
  value: unknown,
  fallbackUntilDate: string
): ActivePeriodProduct[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item as Partial<ActivePeriodProduct>)
    .filter((item) => typeof item.name === "string" && item.name.trim().length > 0)
    .map((item) => ({
      id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
      name: String(item.name || "").trim(),
      scope: normalizeActiveProductScope(item.scope),
      untilDate: typeof item.untilDate === "string" ? item.untilDate : fallbackUntilDate,
      prefer: item.prefer !== false,
      note: typeof item.note === "string" ? item.note.slice(0, ACTIVE_PRODUCT_NOTE_MAX_LENGTH) : "",
      hidden: item.hidden === true,
    }));
};

const normalizeMenuItem = (item: MenuItem): MenuItem => {
  if (item.type === "text") {
    return {
      ...item,
      includeInShopping: item.includeInShopping ?? true,
      ingredients: item.ingredients || [],
      cooked: item.cooked ?? false,
    };
  }
  return {
    ...item,
    cooked: item.cooked ?? false,
  };
};

const normalizeMenuDataRecord = (value: unknown): Record<string, MenuItem[]> => {
  if (!value || typeof value !== "object") return {};
  const converted: Record<string, MenuItem[]> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, rawCell]) => {
    const rows = Array.isArray(rawCell) ? rawCell : [rawCell];
    converted[key] = rows
      .filter((row) => row && typeof row === "object")
      .map((row) => normalizeMenuItem(row as MenuItem));
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

const createMenuProfileState = (name: string, id?: string): MenuProfileState => ({
  id: id || crypto.randomUUID(),
  name: normalizeMenuProfileName(name) || DEFAULT_MENU_NAME_FALLBACK,
  mealData: {},
  cellPeopleCount: {},
  cookedStatus: {},
});

const parseMenuBundleFromStorage = (
  raw: string | null,
  legacyCellPeopleCount: Record<string, number>,
  legacyCookedStatus: Record<string, boolean>,
  defaultMenuName: string
): { menus: MenuProfileState[]; activeMenuId: string } => {
  if (!raw) {
    const defaultMenu = createMenuProfileState(defaultMenuName);
    return { menus: [defaultMenu], activeMenuId: defaultMenu.id };
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Partial<MenuStorageBundleV2>).version === MENU_STORAGE_VERSION &&
      Array.isArray((parsed as Partial<MenuStorageBundleV2>).menus)
    ) {
      const bundle = parsed as Partial<MenuStorageBundleV2>;
      const normalizedMenus = (bundle.menus || [])
        .map((menu) => menu as Partial<MenuProfileState>)
        .filter((menu) => typeof menu.name === "string" && menu.name.trim().length > 0)
        .map((menu) => ({
          id: typeof menu.id === "string" && menu.id ? menu.id : crypto.randomUUID(),
          name: String(menu.name || "").trim(),
          mealData: normalizeMenuDataRecord(menu.mealData),
          cellPeopleCount: normalizePeopleCountMap(menu.cellPeopleCount),
          cookedStatus: normalizeCookedStatusMap(menu.cookedStatus),
        }));
      if (normalizedMenus.length > 0) {
        const activeId = String(bundle.activeMenuId || "").trim();
        const resolvedActiveId = normalizedMenus.some((menu) => menu.id === activeId)
          ? activeId
          : normalizedMenus[0].id;
        return { menus: normalizedMenus, activeMenuId: resolvedActiveId };
      }
    }

    const legacyMealData = normalizeMenuDataRecord(parsed);
    const legacyMenu = createMenuProfileState(defaultMenuName);
    legacyMenu.mealData = legacyMealData;
    legacyMenu.cellPeopleCount = legacyCellPeopleCount;
    legacyMenu.cookedStatus = legacyCookedStatus;
    return { menus: [legacyMenu], activeMenuId: legacyMenu.id };
  } catch {
    const defaultMenu = createMenuProfileState(defaultMenuName);
    return { menus: [defaultMenu], activeMenuId: defaultMenu.id };
  }
};

interface QuickRecipeConfirm {
  recipeId: string;
  recipeTitle: string;
  cellKey: string;
  dayLabel: string;
  mealLabel: string;
}

const hasCountableIngredients = (ingredients: Ingredient[] | undefined): boolean =>
  Array.isArray(ingredients) && ingredients.some((ingredient) => ingredient.name.trim().length > 0 && ingredient.amount > 0);

const getRecipeFromLocalStorageById = (recipeId: string): Recipe | null => {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(RECIPES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Array<Partial<Recipe>>;
    if (!Array.isArray(parsed)) return null;

    const found = parsed.find((item) => item?.id === recipeId);
    if (!found) return null;

    return {
      id: String(found.id || recipeId),
      title: String(found.title || ""),
      ingredients: Array.isArray(found.ingredients) ? found.ingredients : [],
      shortDescription: typeof found.shortDescription === "string" ? found.shortDescription : "",
      description: typeof found.description === "string" ? found.description : "",
      instructions: typeof found.instructions === "string" ? found.instructions : "",
      categories: Array.isArray(found.categories) ? found.categories : [],
      tags: Array.isArray(found.tags) ? found.tags : [],
      notes: String(found.notes || ""),
      timesCooked: Number(found.timesCooked || 0),
      servings: Number(found.servings || 2),
    };
  } catch {
    return null;
  }
};

const isCountableIngredient = (ingredient: Ingredient): boolean => {
  const unit = String(ingredient.unit || "").trim();
  if (!ingredient.name.trim()) return false;
  if (!unit || isTasteLikeUnit(ingredient.unitId || ingredient.unit_id || unit)) return false;
  return Number.isFinite(ingredient.amount) && ingredient.amount > 0;
};

const readGuestCounter = (key: string): number => {
  if (typeof window === "undefined") return 0;
  const parsed = Number(localStorage.getItem(key) || "0");
  return Number.isFinite(parsed) ? parsed : 0;
};

const incrementGuestCounter = (key: string): number => {
  if (typeof window === "undefined") return 0;
  const next = readGuestCounter(key) + 1;
  localStorage.setItem(key, String(next));
  return next;
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

type PeriodPreset = "7d" | "10d" | "14d" | "month" | "custom";
type DemoMenuTemplateId = "quick" | "family" | "budget";

interface DemoMenuTemplate {
  id: DemoMenuTemplateId;
  title: string;
  description: string;
  meals: Record<MealType, string[]>;
}

interface DeletedMenuItemSnapshot {
  cellKey: string;
  index: number;
  item: MenuItem;
}

// Helper functions for period management
const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const getMonthStart = (date: Date): Date => {
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

const getMonthEnd = (date: Date): Date => {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
};

const parseDateSafe = (raw: string): Date | null => {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const formatDate = (date: Date): string => {
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
};

const resolveIntlLocale = (locale?: string): string => {
  if (locale === "ru") return "ru-RU";
  if (locale === "es") return "es-ES";
  return "en-US";
};

const formatDisplayDate = (date: Date, locale?: string): string => {
  return date.toLocaleDateString(resolveIntlLocale(locale), { day: "2-digit", month: "2-digit" });
};

const getRangeLengthDays = (startRaw: string, endRaw: string): number => {
  const start = parseDateSafe(startRaw);
  const end = parseDateSafe(endRaw);
  if (!start || !end) return 0;
  return Math.max(1, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
};

const buildDayKeys = (startRaw: string, endRaw: string): string[] => {
  const start = parseDateSafe(startRaw);
  const end = parseDateSafe(endRaw);
  if (!start || !end) return [];
  const list: string[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    list.push(formatDate(d));
  }
  return list;
};

const normalizePlanDaysPreference = (value: unknown): PlanDaysPreference => {
  if (value === "weekdays") return "weekdays";
  if (value === "weekends") return "weekends";
  return "all";
};

const isWeekendDayKey = (dayKey: string): boolean => {
  const date = parseDateSafe(dayKey);
  if (!date) return false;
  const day = date.getDay();
  return day === 0 || day === 6;
};

const buildPlanningDaysByPreset = (dayKeys: string[], preset: PlanDaysPreference): string[] => {
  if (preset === "weekdays") {
    const weekdays = dayKeys.filter((dayKey) => !isWeekendDayKey(dayKey));
    return weekdays.length > 0 ? weekdays : [...dayKeys];
  }
  if (preset === "weekends") {
    const weekends = dayKeys.filter((dayKey) => isWeekendDayKey(dayKey));
    return weekends.length > 0 ? weekends : [...dayKeys];
  }
  return [...dayKeys];
};

const normalizePlanningDayKeys = (value: unknown, dayKeys: string[]): string[] => {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(dayKeys);
  const selected = new Set<string>();
  for (const raw of value) {
    if (typeof raw === "string" && allowed.has(raw)) {
      selected.add(raw);
    }
  }
  return dayKeys.filter((dayKey) => selected.has(dayKey));
};

const areDayKeyListsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((dayKey, index) => dayKey === right[index]);
};

const getRangeDisplay = (startRaw: string, endRaw: string, locale?: string): string => {
  const start = parseDateSafe(startRaw);
  const end = parseDateSafe(endRaw);
  if (!start || !end) return "";
  return `${formatDisplayDate(start, locale)}-${formatDisplayDate(end, locale)}`;
};

const getWeekdayLabel = (raw: string, locale?: string): string => {
  const date = parseDateSafe(raw);
  if (!date) return "";
  const text = date.toLocaleDateString(resolveIntlLocale(locale), { weekday: "short" }).replace(".", "");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const getWeekdayLong = (raw: string, locale?: string): string => {
  const date = parseDateSafe(raw);
  if (!date) return "";
  return date.toLocaleDateString(resolveIntlLocale(locale), { weekday: "long" });
};

const normalizeMatchText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "");

const detectMealType = (value: string): MealType | null => {
  const normalized = normalizeMatchText(value);
  if (!normalized) return null;

  if (
    /(\bbreakfast\b|desayuno|завтрак|утр|каша|омлет|олад|блин|oat|avena|tostad)/u.test(
      normalized
    )
  ) {
    return "breakfast";
  }

  if (/(\blunch\b|almuerzo|comida|обед|суп|menu del dia)/u.test(normalized)) {
    return "lunch";
  }

  if (/(\bdinner\b|cena|supper|ужин|вечер)/u.test(normalized)) {
    return "dinner";
  }

  return null;
};

const selectMealLabelByType = (
  mealType: MealType,
  dayMeals: string[],
  defaultDayMeals: readonly string[]
): string => {
  const candidates = dayMeals.length > 0 ? dayMeals : [...defaultDayMeals];
  const direct = candidates.find((meal) => detectMealType(meal) === mealType);
  if (direct) return direct;
  const byIndex = candidates[MEAL_TYPE_INDEX[mealType]];
  if (byIndex) return byIndex;
  return candidates[candidates.length - 1] || defaultDayMeals[defaultDayMeals.length - 1] || "";
};

const resolvePreferredMealTypeForRecipe = (
  recipe: (Recipe & { tags?: string[] }) | undefined,
  mealFromQueryRaw: string
): MealType => {
  const fromQuery = detectMealType(mealFromQueryRaw);
  if (fromQuery) return fromQuery;

  const text = [
    recipe?.title || "",
    recipe?.notes || "",
    ...(recipe?.categories || []),
    ...((recipe?.tags || []) as string[]),
  ]
    .join(" ")
    .toLowerCase();

  const fromRecipe = detectMealType(text);
  if (fromRecipe) return fromRecipe;

  return "dinner";
};

/**
 * Note:
 * AddEditDialog вынесен из MenuPage, чтобы React не пересоздавал компонент на каждом рендере.
 */
interface AddEditDialogProps {
  addingItemCell: string | null;
  editingItem: { cellKey: string; index: number; id?: string } | null;
  recipes: Recipe[];
  mealData: Record<string, MenuItem[]>;
  cellPeopleCount: Record<string, number>;
  modalRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onConfirm: (cellKey: string, item: MenuItem) => void;
}

const AddEditDialog = memo(({ 
  addingItemCell, 
  editingItem, 
  recipes,
  mealData,
  cellPeopleCount,
  modalRef, 
  onClose, 
  onConfirm 
}: AddEditDialogProps) => {
  const { locale, t } = useI18n();
  const unitOptions = INGREDIENT_UNIT_IDS.map((id) => ({ id, label: getUnitLabelById(id, locale) }));
  const getDefaultIngredient = (): Ingredient => ({
    id: crypto.randomUUID(),
    name: "",
    amount: 0,
    unitId: DEFAULT_UNIT_ID,
    unit: getUnitLabelById(DEFAULT_UNIT_ID, locale),
  });

  const getEffectivePeopleCount = (cellKey: string) => {
    return cellPeopleCount[cellKey] || 1;
  };

  const editingMenuItem = editingItem
    ? mealData[editingItem.cellKey]?.[editingItem.index] || null
    : null;
  const initialDialogCellKey = editingItem?.cellKey || addingItemCell || "";

  // Local form state
  const [localItemType, setLocalItemType] = useState<"recipe" | "text">(() =>
    editingMenuItem?.type === "text" ? "text" : "recipe"
  );
  const [localText, setLocalText] = useState(() =>
    editingMenuItem?.type === "text" ? editingMenuItem.value || "" : ""
  );
  const [localRecipeId, setLocalRecipeId] = useState(() =>
    editingMenuItem?.type === "recipe" ? editingMenuItem.recipeId || "" : ""
  );
  const [localIncludeInShopping, setLocalIncludeInShopping] = useState(
    () => editingMenuItem?.includeInShopping ?? true
  );
  const [localIngredients, setLocalIngredients] = useState<Ingredient[]>(() => {
    if (editingMenuItem?.ingredients?.length) {
      return editingMenuItem.ingredients.map((ingredient) => ({ ...ingredient }));
    }
    return [getDefaultIngredient()];
  });
  const productSuggestions = loadProductSuggestions();
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<number | null>(null);
  const [localPeopleInput, setLocalPeopleInput] = useState(() => {
    if (!initialDialogCellKey) return "1";
    return String(getEffectivePeopleCount(initialDialogCellKey));
  });
  const [isMobileSheet, setIsMobileSheet] = useState(false);
  const [sheetOffsetY, setSheetOffsetY] = useState(0);
  const sheetSwipeStartYRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia("(max-width: 720px)");
    const sync = () => setIsMobileSheet(media.matches);
    sync();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }

    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  const handleSheetSwipeStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobileSheet || e.touches.length !== 1) return;
    sheetSwipeStartYRef.current = e.touches[0].clientY;
  };

  const handleSheetSwipeMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobileSheet || sheetSwipeStartYRef.current === null || e.touches.length !== 1) return;
    const deltaY = e.touches[0].clientY - sheetSwipeStartYRef.current;
    setSheetOffsetY(deltaY > 0 ? deltaY : 0);
  };

  const handleSheetSwipeEnd = () => {
    if (!isMobileSheet) return;
    if (sheetOffsetY > 90) {
      onClose();
      return;
    }
    setSheetOffsetY(0);
    sheetSwipeStartYRef.current = null;
  };

  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string | number) => {
    setLocalIngredients((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const handleIngredientUnitChange = (index: number, unitId: UnitId) => {
    setLocalIngredients((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        unitId,
        unit: getUnitLabelById(unitId, locale),
      };
      return updated;
    });
  };

  const addIngredientField = () => {
    setLocalIngredients((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: "",
        amount: 0,
        unitId: DEFAULT_UNIT_ID,
        unit: getUnitLabelById(DEFAULT_UNIT_ID, locale),
      },
    ]);
  };

  const removeIngredientField = (index: number) => {
    setLocalIngredients((prev) => prev.filter((_, i) => i !== index));
    setActiveSuggestionIndex((prev) => (prev === index ? null : prev));
  };

  const getIngredientSuggestions = (value: string): string[] => {
    const query = value.trim().toLowerCase();
    if (query.length < 2) return [];
    return productSuggestions
      .filter((name) => name.toLowerCase().includes(query))
      .slice(0, 6);
  };

  const handleConfirm = () => {
    if (!addingItemCell) return;

    // Validation
    if (localItemType === "recipe" && !localRecipeId) return;
    if (localItemType === "text" && !localText.trim()) return;

    const peopleCount = Math.max(1, parseInt(localPeopleInput) || 1);
    const selectedRecipe =
      localItemType === "recipe"
        ? recipes.find((recipe) => recipe.id === localRecipeId) || getRecipeFromLocalStorageById(localRecipeId)
        : null;
    const baseServings = selectedRecipe?.servings && selectedRecipe.servings > 0 ? selectedRecipe.servings : 2;
    const scale = peopleCount / baseServings;
    const scaledRecipeIngredients =
      selectedRecipe?.ingredients
        ?.filter(
          (ing) => ing.name.trim() && (isTasteLikeUnit(ing.unitId || ing.unit_id || ing.unit) || ing.amount > 0)
        )
        .map((ing) => ({
          ...ing,
          amount: isTasteLikeUnit(ing.unitId || ing.unit_id || ing.unit) ? 0 : ing.amount * scale,
        })) || [];

    // Build MenuItem object
    const menuItem: MenuItem = localItemType === "recipe"
      ? { 
          type: "recipe", 
          recipeId: localRecipeId, 
          value: selectedRecipe?.title || undefined,
          cooked: false, 
          id: editingItem?.id || crypto.randomUUID(),
          includeInShopping: true,
          ingredients: scaledRecipeIngredients,
        }
      : {
          type: "text",
          value: localText.trim(),
          includeInShopping: localIncludeInShopping,
          ingredients: localIncludeInShopping
            ? localIngredients.filter(
                (ing) => ing.name.trim() && (isTasteLikeUnit(ing.unitId || ing.unit_id || ing.unit) || ing.amount > 0)
              )
            : undefined,
          id: editingItem?.id || crypto.randomUUID()
        };

    // Scale text-item ingredients by people count
    if (localItemType === "text" && menuItem.ingredients) {
      menuItem.ingredients = menuItem.ingredients.map((ing) => ({
        ...ing,
        amount: ing.amount * peopleCount,
      }));
    }

    const namesForSuggestions =
      localItemType === "recipe"
        ? (selectedRecipe?.ingredients || []).map((ing) => ing.name.trim()).filter((name) => name.length > 0)
        : localIngredients.map((ing) => ing.name.trim()).filter((name) => name.length > 0);
    if (namesForSuggestions.length > 0) {
      appendProductSuggestions(namesForSuggestions);
    }

    onConfirm(addingItemCell, menuItem);
    onClose();
  };

  if (!addingItemCell) return null;

  return createPortal(
    <div
      className="menu-dialog-overlay"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: isMobileSheet ? "flex-end" : "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.5)",
        zIndex: 10000,
        padding: isMobileSheet ? "0" : "16px",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="menu-dialog"
        style={{
          position: "relative",
          zIndex: 10001,
          backgroundColor: "#fff",
          opacity: 1,
          color: "inherit",
          border: "1px solid #ddd",
          borderRadius: isMobileSheet ? "16px 16px 0 0" : "8px",
          padding: isMobileSheet ? "12px 14px calc(12px + env(safe-area-inset-bottom, 0px))" : "20px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          minWidth: isMobileSheet ? "100%" : "400px",
          maxWidth: isMobileSheet ? "100%" : "90vw",
          width: isMobileSheet ? "100%" : undefined,
          height: isMobileSheet ? "70vh" : undefined,
          maxHeight: isMobileSheet ? "70vh" : "90vh",
          overflowY: "auto",
          transform: isMobileSheet ? `translateY(${sheetOffsetY}px)` : undefined,
          transition: isMobileSheet ? "transform 0.18s ease-out" : undefined,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {isMobileSheet ? (
          <div
            style={{ display: "flex", justifyContent: "center", padding: "0 0 6px 0", cursor: "grab" }}
            onTouchStart={handleSheetSwipeStart}
            onTouchMove={handleSheetSwipeMove}
            onTouchEnd={handleSheetSwipeEnd}
            onTouchCancel={handleSheetSwipeEnd}
          >
            <span
              aria-hidden="true"
              style={{
                width: "44px",
                height: "4px",
                borderRadius: "999px",
                background: "var(--border-default)",
                display: "inline-block",
              }}
            />
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, color: "#333" }}>
            {editingItem ? t("menu.dialog.editDish") : t("menu.dialog.addDish")}
          </h3>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{
              background: "none",
              border: "none",
              fontSize: "20px",
              cursor: "pointer",
              color: "#666",
              padding: 0,
              width: "24px",
              height: "24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "50%",
            }}
            title={t("menu.actions.close")}
          >
            ×
          </button>
        </div>

        <div className="menu-dialog__type-selector">
          <label>
            <input
              type="radio"
              name="itemType"
              value="recipe"
              checked={localItemType === "recipe"}
              onChange={(e) => setLocalItemType(e.target.value as "recipe" | "text")}
            />
            {t("menu.dialog.typeRecipe")}
          </label>
          <label>
            <input
              type="radio"
              name="itemType"
              value="text"
              checked={localItemType === "text"}
              onChange={(e) => setLocalItemType(e.target.value as "recipe" | "text")}
            />
            {t("menu.dialog.typeText")}
          </label>
        </div>

        {localItemType === "recipe" ? (
          <div className="menu-dialog__recipe-selector">
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "12px" }}>
              {t("menu.dialog.chooseRecipe")}
              <select value={localRecipeId} onChange={(e) => setLocalRecipeId(e.target.value)} className="menu-dialog__select">
                <option value="">{t("menu.dialog.chooseRecipePlaceholder")}</option>
                {recipes.map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    {recipe.title}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {t("menu.dialog.servingsCount")}
              <input
                type="number"
                value={localPeopleInput}
                onChange={(e) => setLocalPeopleInput(e.target.value)}
                className="menu-dialog__people-input"
                min="1"
                step="1"
              />
            </label>
          </div>
        ) : (
          <div className="menu-dialog__text-input">
            <div className="menu-dialog__people-count">
              <label>
                {t("menu.dialog.howManyServings")}
                <input
                  type="number"
                  value={localPeopleInput}
                  onChange={(e) => setLocalPeopleInput(e.target.value)}
                  className="menu-dialog__people-input"
                  min="1"
                  step="1"
                />
              </label>
            </div>
            <input
              type="text"
              value={localText}
              onChange={(e) => setLocalText(e.target.value)}
              placeholder={t("menu.dialog.enterText")}
              className="menu-dialog__input"
            />

            <div className="menu-dialog__shopping-option">
              <label>
                <input
                  type="checkbox"
                  checked={localIncludeInShopping}
                  onChange={(e) => setLocalIncludeInShopping(e.target.checked)}
                />
                {t("menu.dialog.includeInShopping")}
              </label>
            </div>

            {localIncludeInShopping && (
              <div className="menu-dialog__ingredients">
                <h4>{t("menu.dialog.ingredients")}</h4>

                {localIngredients.map((ingredient, index) => (
                  <div key={ingredient.id} className="menu-dialog__ingredient-row">
                    <div className="menu-dialog__ingredient-name-wrap">
                      <input
                        type="text"
                        value={ingredient.name}
                        onChange={(e) => {
                          handleIngredientChange(index, "name", e.target.value);
                          setActiveSuggestionIndex(index);
                        }}
                        onFocus={() => setActiveSuggestionIndex(index)}
                        onBlur={() => {
                          setTimeout(() => {
                            setActiveSuggestionIndex((prev) => (prev === index ? null : prev));
                          }, 120);
                        }}
                        autoComplete="off"
                        placeholder={t("menu.dialog.ingredientName")}
                        className="menu-dialog__ingredient-name"
                      />
                      {activeSuggestionIndex === index && (
                        <div className="menu-dialog__ingredient-suggestions">
                          {getIngredientSuggestions(ingredient.name).map((name) => (
                            <button
                              key={name}
                              type="button"
                              className="menu-dialog__ingredient-suggestion"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                handleIngredientChange(index, "name", name);
                                setActiveSuggestionIndex(null);
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <input
                      type="number"
                      value={ingredient.amount || ""}
                      onChange={(e) => handleIngredientChange(index, "amount", parseFloat(e.target.value) || 0)}
                      placeholder={t("menu.dialog.ingredientAmount")}
                      className="menu-dialog__ingredient-amount"
                      min="0"
                      step="0.1"
                    />

                    {tryNormalizeUnitId(ingredient.unitId || ingredient.unit_id || ingredient.unit) ? (
                      <select
                        value={normalizeUnitId(ingredient.unitId || ingredient.unit_id || ingredient.unit || DEFAULT_UNIT_ID, DEFAULT_UNIT_ID)}
                        onChange={(e) => handleIngredientUnitChange(index, e.target.value as UnitId)}
                        className="menu-dialog__ingredient-unit"
                      >
                        {unitOptions.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unit.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={ingredient.unit}
                        onChange={(e) => handleIngredientChange(index, "unit", e.target.value)}
                        placeholder={t("menu.dialog.unitPlaceholder")}
                        className="menu-dialog__ingredient-unit"
                      />
                    )}

                    <button
                      type="button"
                      onClick={() => removeIngredientField(index)}
                      className="menu-dialog__ingredient-remove"
                      title={t("menu.dialog.removeIngredient")}
                    >
                      ×
                    </button>
                  </div>
                ))}

                <button type="button" onClick={addIngredientField} className="menu-dialog__add-ingredient">
                  {t("menu.dialog.addIngredient")}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="menu-dialog__actions">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={(localItemType === "recipe" && !localRecipeId) || (localItemType === "text" && !localText.trim())}
            className="menu-dialog__confirm"
          >
            {t("menu.actions.save")}
          </button>

          <button type="button" onClick={onClose} className="menu-dialog__cancel">
            {t("menu.actions.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
});

AddEditDialog.displayName = "AddEditDialog";

function MenuPageContent() {
  const { locale, t } = useI18n();
  const { confirm, confirmDialog } = usePlanottoConfirm();
  const { planTier } = usePlanTier();
  const defaultMenuName = t("menu.fallback.defaultMenuName");
  const defaultDayMeals = useMemo(
    () => [t("menu.meals.breakfast"), t("menu.meals.lunch"), t("menu.meals.dinner")],
    [t]
  );
  const snackMealLabel = t("menu.meals.snack");
  const initialMealsPerDayPreference: MealsPerDayPreference = "3";
  const initialTwoMealsMode: TwoMealsMode = "breakfast_lunch";
  const initialRangeStart = formatDate(getMonday(new Date()));
  const initialRangeEnd = formatDate(addDays(getMonday(new Date()), 6));
  const initialMealRangeKey = `${initialRangeStart}__${initialRangeEnd}`;

  const [dayStructureMode, setDayStructureMode] = useState<DayStructureMode>(() => {
    if (typeof window === "undefined") return "list";
    const raw = window.localStorage.getItem(DAY_STRUCTURE_MODE_KEY);
    return raw === "meals" ? "meals" : "list";
  });
  const [profileMealsPerDayPreference, setProfileMealsPerDayPreference] =
    useState<MealsPerDayPreference>(initialMealsPerDayPreference);
  const [twoMealsMode, setTwoMealsMode] = useState<TwoMealsMode>(() => {
    if (typeof window === "undefined") return initialTwoMealsMode;
    return normalizeTwoMealsMode(window.localStorage.getItem(MENU_TWO_MEALS_MODE_KEY));
  });
  const [mealSlots, setMealSlots] = useState<MealSlotSetting[]>(() =>
    loadMealSlotsFromStorage(
      initialMealRangeKey,
      defaultDayMeals,
      snackMealLabel,
      initialMealsPerDayPreference,
      initialTwoMealsMode
    )
  );
  const [mealSlotsHydrated, setMealSlotsHydrated] = useState(false);

  const orderedMealSlots = useMemo(
    () => [...mealSlots].sort((a, b) => a.order - b.order),
    [mealSlots]
  );

  const getDayMeals = useCallback(
    (_dayKey: string) => {
      const visible = orderedMealSlots.filter((slot) => slot.visible).map((slot) => slot.name);
      return visible.length > 0 ? visible : [...defaultDayMeals];
    },
    [defaultDayMeals, orderedMealSlots]
  );

  const getAllMealsForDay = useCallback(
    (_dayKey: string) => {
      const all = orderedMealSlots.map((slot) => slot.name);
      return all.length > 0 ? all : [...defaultDayMeals];
    },
    [defaultDayMeals, orderedMealSlots]
  );

  const [mealData, setMealData] = useState<Record<string, MenuItem[]>>({});
  const [menuProfiles, setMenuProfiles] = useState<MenuProfileState[]>([]);
  const [activeMenuId, setActiveMenuId] = useState("");
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [showMenuSettingsDialog, setShowMenuSettingsDialog] = useState(false);
  const [showMenuTemplatesPanel, setShowMenuTemplatesPanel] = useState(false);
  const [isCreateMenuDialogOpen, setIsCreateMenuDialogOpen] = useState(false);
  const [newMenuNameDraft, setNewMenuNameDraft] = useState("");
  const [pendingDeleteMenuId, setPendingDeleteMenuId] = useState<string | null>(null);
  const [mergeShoppingWithAllMenus, setMergeShoppingWithAllMenus] = useState(false);
  const [showAddRecipePromptInRecipes, setShowAddRecipePromptInRecipes] = useState(true);
  const [profileGoal, setProfileGoal] = useState<ProfileGoal>("menu");
  const [profilePlanDaysPreference, setProfilePlanDaysPreference] = useState<PlanDaysPreference>("all");
  const [showMealSettingsDialog, setShowMealSettingsDialog] = useState(false);
  const [newMealSlotName, setNewMealSlotName] = useState("");
  const [saveMealSlotsAsDefault, setSaveMealSlotsAsDefault] = useState(false);

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);

  const [cellPeopleCount, setCellPeopleCount] = useState<Record<string, number>>({});
  const [weekStart, setWeekStart] = useState<string>(() => initialRangeStart);
  const [periodEnd, setPeriodEnd] = useState<string>(() => initialRangeEnd);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("7d");
  const [planningDayKeys, setPlanningDayKeys] = useState<string[]>([]);
  const [customStartInput, setCustomStartInput] = useState<string>(() => initialRangeStart);
  const [customEndInput, setCustomEndInput] = useState<string>(() => initialRangeEnd);

  const [addingItemCell, setAddingItemCell] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const [newItemType, setNewItemType] = useState<"recipe" | "text">("recipe");
  const [newItemText, setNewItemText] = useState("");
  const [newItemRecipeId, setNewItemRecipeId] = useState("");
  const [newItemIncludeInShopping, setNewItemIncludeInShopping] = useState(true);
  const [newItemIngredients, setNewItemIngredients] = useState<Ingredient[]>([
    { id: crypto.randomUUID(), name: "", amount: 0, unitId: DEFAULT_UNIT_ID, unit: DEFAULT_UNIT },
  ]);
  const [newItemPeopleCount, setNewItemPeopleCount] = useState(1);
  const [peopleInput, setPeopleInput] = useState("1");

  const [recipeCategoryFilter, setRecipeCategoryFilter] = useState<string>(RECIPE_CATEGORY_FILTER_ALL);

  const [openMoreMenu, setOpenMoreMenu] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ cellKey: string; index: number; rect: DOMRect } | null>(null);

  const [editingItem, setEditingItem] = useState<{ cellKey: string; index: number } | null>(null);

  const [movingItem, setMovingItem] = useState<{ cellKey: string; index: number } | null>(null);
  const [moveTargetDay, setMoveTargetDay] = useState<string>("");
  const [moveTargetMeal, setMoveTargetMeal] = useState<string>("");
  const dialogMouseDownRef = useRef(false);
  const mealSlotsRangeKey = `${weekStart}__${periodEnd}`;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(RANGE_STATE_KEY, JSON.stringify({ start: weekStart, end: periodEnd }));
      localStorage.setItem(WEEK_START_KEY, weekStart);
    } catch {
      // ignore localStorage write issues
    }
  }, [weekStart, periodEnd]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(DAY_STRUCTURE_MODE_KEY, dayStructureMode);
  }, [dayStructureMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(MENU_TWO_MEALS_MODE_KEY, twoMealsMode);
  }, [twoMealsMode]);

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
    if (typeof window === "undefined") return;
    setMealSlots(
      loadMealSlotsFromStorage(
        mealSlotsRangeKey,
        defaultDayMeals,
        snackMealLabel,
        profileMealsPerDayPreference,
        twoMealsMode
      )
    );
    setMealSlotsHydrated(true);
  }, [defaultDayMeals, mealSlotsRangeKey, profileMealsPerDayPreference, snackMealLabel, twoMealsMode]);

  useEffect(() => {
    if (typeof window === "undefined" || !mealSlotsHydrated) return;
    localStorage.setItem(`${MEAL_STRUCTURE_SETTINGS_KEY}:${mealSlotsRangeKey}`, JSON.stringify(mealSlots));
  }, [mealSlots, mealSlotsHydrated, mealSlotsRangeKey]);

  const router = useRouter();
  const searchParams = useSearchParams();
  const forceFirstFromQuery = searchParams.get("first") === "1";

  const [cookedStatus, setCookedStatus] = useState<Record<string, boolean>>({});
  const [pantry, setPantry] = useState<PantryItem[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [menuMode, setMenuMode] = useState<"mine" | "public">("mine");
  const [weekVisibility, setWeekVisibility] = useState<MenuWeekVisibility>("private");
  const [publicWeeks, setPublicWeeks] = useState<PublicWeekSummary[]>([]);
  const [selectedPublicWeekId, setSelectedPublicWeekId] = useState("");
  const [menuSyncError, setMenuSyncError] = useState("");
  const [isExportingMenuPdf, setIsExportingMenuPdf] = useState(false);
  const [isExportingMenuWithRecipesPdf, setIsExportingMenuWithRecipesPdf] = useState(false);
  const [showPdfExportDialog, setShowPdfExportDialog] = useState(false);
  const [pdfExportMode, setPdfExportMode] = useState<"menu" | "menu_full">("menu");
  const [activeProducts, setActiveProducts] = useState<ActivePeriodProduct[]>([]);
  const [activeProductName, setActiveProductName] = useState("");
  const [activeProductsSearch, setActiveProductsSearch] = useState("");
  const [showActiveProductsDialog, setShowActiveProductsDialog] = useState(false);
  const [expandedActiveProductNoteId, setExpandedActiveProductNoteId] = useState<string | null>(null);
  const [activeProductNoteDrafts, setActiveProductNoteDrafts] = useState<Record<string, string>>({});
  const [activeProductSavedNoteId, setActiveProductSavedNoteId] = useState<string | null>(null);
  const [activeProductsCloudHydrated, setActiveProductsCloudHydrated] = useState(false);
  const [showFirstVisitOnboarding, setShowFirstVisitOnboarding] = useState(() => forceFirstFromQuery);
  const [showCalendarInlineHint, setShowCalendarInlineHint] = useState(false);
  const [forcedOnboardingFlow, setForcedOnboardingFlow] = useState(() => forceFirstFromQuery);
  const [pendingRecipeForMenu, setPendingRecipeForMenu] = useState<string | null>(null);
  const [quickRecipeConfirm, setQuickRecipeConfirm] = useState<QuickRecipeConfirm | null>(null);
  const [showMenuAddedNotice, setShowMenuAddedNotice] = useState(false);
  const [menuAddedHasIngredients, setMenuAddedHasIngredients] = useState(false);
  const [deletedMenuItem, setDeletedMenuItem] = useState<DeletedMenuItemSnapshot | null>(null);
  const [showGuestReminder, setShowGuestReminder] = useState(false);
  const [guestReminderStrong, setGuestReminderStrong] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const guestVisitTrackedRef = useRef(false);
  const activeProductsSaveTimerRef = useRef<number | null>(null);
  const activeProductSavedNoteTimerRef = useRef<number | null>(null);
  const deleteUndoTimerRef = useRef<number | null>(null);

  const rangeKey = `${weekStart}__${periodEnd}`;
  const periodDays = getRangeLengthDays(weekStart, periodEnd);
  const planningDaysStorageKey = `${MENU_PLANNING_DAYS_KEY_PREFIX}:${rangeKey}`;
  const dayKeys = useMemo(() => buildDayKeys(weekStart, periodEnd), [weekStart, periodEnd]);
  const dayEntries = useMemo(
    () =>
      dayKeys
        .map((dateKey) => {
          const date = parseDateSafe(dateKey);
          if (!date) return null;
          return {
            dateKey,
            dayLabel: getWeekdayLabel(dateKey, locale),
            displayDate: formatDisplayDate(date, locale),
          };
        })
        .filter((entry): entry is { dateKey: string; dayLabel: string; displayDate: string } => Boolean(entry)),
    [dayKeys, locale]
  );
  const defaultPlanningDayKeys = useMemo(
    () => buildPlanningDaysByPreset(dayKeys, profilePlanDaysPreference),
    [dayKeys, profilePlanDaysPreference]
  );
  const visibleDayEntries = useMemo(() => {
    const selected = new Set(planningDayKeys);
    const filtered = dayEntries.filter((entry) => selected.has(entry.dateKey));
    return filtered.length > 0 ? filtered : dayEntries;
  }, [dayEntries, planningDayKeys]);
  const visibleDayKeys = useMemo(() => visibleDayEntries.map((entry) => entry.dateKey), [visibleDayEntries]);
  const visibleDayCount = visibleDayEntries.length;
  const activeLocale = resolveIntlLocale(locale);
  const getMenuDisplayName = useCallback(
    (rawName: string): string => {
      const normalized = String(rawName || "").trim();
      if (!normalized) return defaultMenuName;
      if (SYSTEM_MENU_NAME_ALIASES.has(normalized.toLocaleLowerCase(activeLocale))) {
        return defaultMenuName;
      }
      return normalized;
    },
    [activeLocale, defaultMenuName]
  );
  const canUseMultipleMenus = isPaidFeatureEnabled(planTier, "multiple_menus");
  const canUsePdfExport = isPaidFeatureEnabled(planTier, "pdf_export");
  const isAnyMenuPdfExporting = isExportingMenuPdf || isExportingMenuWithRecipesPdf;
  const additionalMenusLocked = !canUseMultipleMenus && menuProfiles.length >= 1;
  const countMenuItems = useCallback(
    (data: Record<string, MenuItem[]>) =>
      Object.values(data || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0),
    []
  );
  const isActiveMenuEmpty = useMemo(() => countMenuItems(mealData) === 0, [countMenuItems, mealData]);
  const allMenusEmpty = useMemo(() => {
    if (menuProfiles.length === 0) return true;
    return menuProfiles.every((menu) => {
      const sourceMealData = menu.id === activeMenuId ? mealData : menu.mealData;
      return countMenuItems(sourceMealData) === 0;
    });
  }, [activeMenuId, countMenuItems, mealData, menuProfiles]);
  const shouldShowMenuTemplatesPanel = allMenusEmpty || showMenuTemplatesPanel;
  const visibleActiveProductsCount = activeProducts.length;
  const shouldEnableActiveProductsSearch = activeProducts.length >= 8;
  const shouldShowActiveProductsSearch = shouldEnableActiveProductsSearch && expandedActiveProductNoteId === null;
  const normalizedActiveProductsSearch = shouldShowActiveProductsSearch
    ? activeProductsSearch.trim().toLocaleLowerCase(activeLocale)
    : "";
  const filteredActiveProducts = useMemo(() => {
    const ordered = [...activeProducts].sort((a, b) => a.name.localeCompare(b.name, activeLocale));
    if (!normalizedActiveProductsSearch) return ordered;
    return ordered.filter((item) => {
      const safeName = typeof item.name === "string" ? item.name : "";
      const safeNote = typeof item.note === "string" ? item.note : "";
      const inName = safeName.toLocaleLowerCase(activeLocale).includes(normalizedActiveProductsSearch);
      const inNote = safeNote.toLocaleLowerCase(activeLocale).includes(normalizedActiveProductsSearch);
      return inName || inNote;
    });
  }, [activeLocale, activeProducts, normalizedActiveProductsSearch]);
  const activeProductAutocompleteSuggestions = useMemo(() => {
    const unique = new Map<string, string>();
    const pushSuggestion = (rawName: string) => {
      const normalized = sanitizeProductSuggestion(rawName);
      if (!normalized) return;
      const key = normalized.toLocaleLowerCase(activeLocale);
      if (!unique.has(key)) {
        unique.set(key, normalized);
      }
    };

    STARTER_PRODUCT_SUGGESTIONS.forEach((item) => pushSuggestion(item));
    pantry.forEach((item) => pushSuggestion(item.name));
    activeProducts.forEach((item) => pushSuggestion(item.name));

    return Array.from(unique.values()).sort((a, b) => a.localeCompare(b, activeLocale, { sensitivity: "base" }));
  }, [activeLocale, activeProducts, pantry]);

  const menuStorageKey = `${MENU_STORAGE_KEY}:${rangeKey}`;
  const cellPeopleCountKey = `${CELL_PEOPLE_COUNT_KEY}:${rangeKey}`;
  const cookedStatusKey = `cookedStatus:${rangeKey}`;
  const activeProductsKey = `activeProducts:${rangeKey}`;
  const getMergeShoppingKey = useCallback(
    (targetRangeKey: string) => `${MENU_SHOPPING_MERGE_KEY_PREFIX}:${targetRangeKey}`,
    []
  );
  const buildNameDrafts = useCallback((menus: MenuProfileState[]): Record<string, string> => {
    const drafts: Record<string, string> = {};
    menus.forEach((menu) => {
      drafts[menu.id] = menu.name;
    });
    return drafts;
  }, []);
  const persistMenuBundleSnapshot = useCallback(
    (nextProfiles: MenuProfileState[], nextActiveMenuId: string) => {
      if (typeof window === "undefined") return;
      const payload: MenuStorageBundleV2 = {
        version: MENU_STORAGE_VERSION,
        activeMenuId: nextActiveMenuId,
        menus: nextProfiles,
      };
      localStorage.setItem(menuStorageKey, JSON.stringify(payload));
    },
    [menuStorageKey]
  );

  const getCellKey = (day: string, meal: string) => `${day}-${meal}`;
  const migrateMealNameInMenus = (
    menus: MenuProfileState[],
    fromName: string,
    toName: string
  ): MenuProfileState[] => {
    if (!fromName || !toName || fromName === toName) return menus;

    return menus.map((menu) => {
      const nextMealData: Record<string, MenuItem[]> = { ...menu.mealData };
      Object.entries(menu.mealData).forEach(([cellKey, items]) => {
        const parsed = splitCellKey(cellKey);
        if (!parsed || parsed.mealLabel !== fromName) return;
        const targetKey = getCellKey(parsed.dayKey, toName);
        nextMealData[targetKey] = [...(nextMealData[targetKey] || []), ...(items || [])];
        delete nextMealData[cellKey];
      });

      const nextCellPeopleCount: Record<string, number> = { ...menu.cellPeopleCount };
      Object.entries(menu.cellPeopleCount).forEach(([cellKey, count]) => {
        const parsed = splitCellKey(cellKey);
        if (!parsed || parsed.mealLabel !== fromName) return;
        const targetKey = getCellKey(parsed.dayKey, toName);
        nextCellPeopleCount[targetKey] = count;
        delete nextCellPeopleCount[cellKey];
      });

      return {
        ...menu,
        mealData: nextMealData,
        cellPeopleCount: nextCellPeopleCount,
      };
    });
  };
  const getListAppendMeal = useCallback(
    (dayKey: string) => {
      const meals = getAllMealsForDay(dayKey);
      if (meals.length > 0) return meals[meals.length - 1];
      return defaultDayMeals[defaultDayMeals.length - 1] || "";
    },
    [defaultDayMeals, getAllMealsForDay]
  );

  const getDayListEntries = useCallback(
    (dayKey: string): Array<{ cellKey: string; meal: string; index: number; item: MenuItem }> => {
      const entries: Array<{ cellKey: string; meal: string; index: number; item: MenuItem }> = [];
      const meals = getAllMealsForDay(dayKey);
      meals.forEach((meal) => {
        const cellKey = getCellKey(dayKey, meal);
        const items = mealData[cellKey] || [];
        items.forEach((item, index) => entries.push({ cellKey, meal, index, item }));
      });
      return entries;
    },
    [getAllMealsForDay, mealData]
  );

  const persistMenuSnapshot = useCallback(
    (
      nextMealData: Record<string, MenuItem[]>,
      nextCellPeopleCount: Record<string, number> = cellPeopleCount,
      nextCookedStatus: Record<string, boolean> = cookedStatus,
      targetMenuId: string = activeMenuId
    ) => {
      if (typeof window === "undefined") return;
      try {
        const fallbackMenu = createMenuProfileState(defaultMenuName, targetMenuId || undefined);
        const sourceMenus = menuProfiles.length > 0 ? menuProfiles : [fallbackMenu];
        const resolvedTargetId = targetMenuId || sourceMenus[0].id;
        const nextProfiles = sourceMenus.map((menu) => {
          if (menu.id !== resolvedTargetId) return menu;
          if (
            menu.mealData === nextMealData &&
            menu.cellPeopleCount === nextCellPeopleCount &&
            menu.cookedStatus === nextCookedStatus
          ) {
            return menu;
          }
          return {
            ...menu,
            mealData: nextMealData,
            cellPeopleCount: nextCellPeopleCount,
            cookedStatus: nextCookedStatus,
          };
        });
        const profilesChanged =
          nextProfiles.length !== sourceMenus.length ||
          nextProfiles.some((menu, index) => menu !== sourceMenus[index]);
        persistMenuBundleSnapshot(nextProfiles, resolvedTargetId);
        if (profilesChanged) {
          setMenuProfiles(nextProfiles);
        }
        localStorage.setItem(cellPeopleCountKey, JSON.stringify(nextCellPeopleCount));
        localStorage.setItem(cookedStatusKey, JSON.stringify(nextCookedStatus));
      } catch {
        // ignore local storage write errors
      }
    },
    [
      activeMenuId,
      cellPeopleCount,
      cellPeopleCountKey,
      cookedStatus,
      cookedStatusKey,
      defaultMenuName,
      menuProfiles,
      persistMenuBundleSnapshot,
    ]
  );
  const isReadOnly = menuMode === "public";


  const closeDropdownMenu = () => {
    setOpenMoreMenu(null);
    setMenuAnchor(null);
  };

  const closeAddEditDialog = () => {
    setAddingItemCell(null);
    setEditingItem(null);

    setNewItemType("recipe");
    setNewItemText("");
    setNewItemRecipeId("");
    setNewItemIncludeInShopping(true);
    setNewItemIngredients([{ id: crypto.randomUUID(), name: "", amount: 0, unitId: DEFAULT_UNIT_ID, unit: DEFAULT_UNIT }]);
    setNewItemPeopleCount(1);
    setPeopleInput("1");
    setRecipeCategoryFilter(RECIPE_CATEGORY_FILTER_ALL);
  };

  const closeMoveDialog = () => {
    setMovingItem(null);
    setMoveTargetDay("");
    setMoveTargetMeal("");
  };

  const closeActiveProductsDialog = () => {
    setShowActiveProductsDialog(false);
    setExpandedActiveProductNoteId(null);
    setActiveProductsSearch("");
  };

  const closeMenuSettingsDialog = () => {
    setShowMenuSettingsDialog(false);
    setShowMealSettingsDialog(false);
    setIsCreateMenuDialogOpen(false);
    setPendingDeleteMenuId(null);
    setSaveMealSlotsAsDefault(false);
    setNewMealSlotName("");
    setMenuSyncError("");
  };

  const resetAllModalStates = () => {
    closeDropdownMenu();
    closeAddEditDialog();
    closeMoveDialog();
    closeActiveProductsDialog();
    closeMenuSettingsDialog();
    setShowPdfExportDialog(false);
  };

  useEffect(() => {
    if (
      !showPdfExportDialog &&
      !showMenuSettingsDialog &&
      !showMealSettingsDialog &&
      !isCreateMenuDialogOpen &&
      !pendingDeleteMenuId
    ) {
      return;
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showPdfExportDialog) {
        setShowPdfExportDialog(false);
        return;
      }
      if (pendingDeleteMenuId) {
        setPendingDeleteMenuId(null);
        return;
      }
      if (isCreateMenuDialogOpen) {
        setIsCreateMenuDialogOpen(false);
        return;
      }
      if (showMealSettingsDialog) {
        closeMealSettingsDialog();
        return;
      }
      setShowMenuSettingsDialog(false);
    };

    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [isCreateMenuDialogOpen, pendingDeleteMenuId, showMealSettingsDialog, showMenuSettingsDialog, showPdfExportDialog]);

  useEffect(() => {
    if (deleteUndoTimerRef.current !== null) {
      window.clearTimeout(deleteUndoTimerRef.current);
      deleteUndoTimerRef.current = null;
    }
    if (!deletedMenuItem) return;

    deleteUndoTimerRef.current = window.setTimeout(() => {
      setDeletedMenuItem(null);
      deleteUndoTimerRef.current = null;
    }, MENU_DELETE_UNDO_TIMEOUT_MS);

    return () => {
      if (deleteUndoTimerRef.current !== null) {
        window.clearTimeout(deleteUndoTimerRef.current);
        deleteUndoTimerRef.current = null;
      }
    };
  }, [deletedMenuItem]);

  const handleOnboardingAddFirstRecipe = () => {
    setShowFirstVisitOnboarding(false);
    setShowCalendarInlineHint(false);
    setForcedOnboardingFlow(false);
    localStorage.setItem(MENU_FIRST_VISIT_ONBOARDING_KEY, "1");
    localStorage.setItem(RECIPES_FIRST_FLOW_KEY, "1");
    localStorage.removeItem("recipes:first-success-shown");
    localStorage.removeItem("recipes:first-added-recipe-id");
    localStorage.removeItem("recipes:first-success-pending");
    router.replace("/recipes?first=1");
  };

  const handleOnboardingTryWithoutRecipes = () => {
    setShowFirstVisitOnboarding(false);
    const inlineDismissed = localStorage.getItem(MENU_INLINE_HINT_DISMISSED_KEY) === "1";
    setShowCalendarInlineHint(!inlineDismissed);
    setForcedOnboardingFlow(false);
    localStorage.setItem(MENU_FIRST_VISIT_ONBOARDING_KEY, "1");
    router.replace("/menu");
  };

  const dismissCalendarInlineHint = useCallback(() => {
    setShowCalendarInlineHint(false);
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(MENU_INLINE_HINT_DISMISSED_KEY, "1");
    } catch {
      // ignore local storage errors
    }
  }, []);

  const applyPeriodPreset = (preset: PeriodPreset) => {
    const baseStart = parseDateSafe(weekStart) || getMonday(new Date());
    let nextStart = new Date(baseStart);
    let nextEnd = new Date(baseStart);

    if (preset === "month") {
      nextStart = getMonthStart(baseStart);
      nextEnd = getMonthEnd(baseStart);
    } else if (preset === "10d") {
      nextEnd = addDays(nextStart, 9);
    } else if (preset === "14d") {
      nextEnd = addDays(nextStart, 13);
    } else if (preset === "custom") {
      const parsedCustomStart = parseDateSafe(customStartInput);
      const parsedCustomEnd = parseDateSafe(customEndInput);
      if (parsedCustomStart && parsedCustomEnd && parsedCustomStart <= parsedCustomEnd) {
        nextStart = parsedCustomStart;
        nextEnd = parsedCustomEnd;
      } else {
        setMenuSyncError(t("menu.period.invalidCustomRange"));
        return;
      }
    } else {
      nextEnd = addDays(nextStart, 6);
    }

    setMenuSyncError("");
    setPeriodPreset(preset);
    setWeekStart(formatDate(nextStart));
    setPeriodEnd(formatDate(nextEnd));
    setCustomStartInput(formatDate(nextStart));
    setCustomEndInput(formatDate(nextEnd));

    if (!currentUserId) {
      incrementGuestCounter(GUEST_REMINDER_PERIOD_ATTEMPTS_KEY);
    }
  };

  const applyPlanningDaysPreset = useCallback(
    (preset: PlanDaysPreference) => {
      setPlanningDayKeys(buildPlanningDaysByPreset(dayKeys, preset));
    },
    [dayKeys]
  );

  const togglePlanningDay = useCallback(
    (dayKey: string) => {
      setPlanningDayKeys((prev) => {
        const hasDay = prev.includes(dayKey);
        if (hasDay) {
          const next = prev.filter((key) => key !== dayKey);
          if (next.length === 0) return prev;
          return dayKeys.filter((key) => next.includes(key));
        }
        const nextSet = new Set(prev);
        nextSet.add(dayKey);
        return dayKeys.filter((key) => nextSet.has(key));
      });
    },
    [dayKeys]
  );

  const isPlanningPresetActive = useCallback(
    (preset: PlanDaysPreference): boolean => {
      return areDayKeyListsEqual(planningDayKeys, buildPlanningDaysByPreset(dayKeys, preset));
    },
    [dayKeys, planningDayKeys]
  );

  const applyMealsPerDayPreset = useCallback(
    (mealsPerDay: MealsPerDayPreference, selectedTwoMealsMode: TwoMealsMode = twoMealsMode) => {
      const nextSlots = buildMealSlotsByMealsPerDay(
        defaultDayMeals,
        snackMealLabel,
        mealsPerDay,
        selectedTwoMealsMode
      );
      setMealSlots(nextSlots);
    },
    [defaultDayMeals, snackMealLabel, twoMealsMode]
  );

  const shiftPeriod = (direction: -1 | 1) => {
    const parsedStart = parseDateSafe(weekStart);
    const parsedEnd = parseDateSafe(periodEnd);
    if (!parsedStart || !parsedEnd) return;
    const shiftDays = Math.max(1, periodDays) * direction;
    const nextStart = addDays(parsedStart, shiftDays);
    const nextEnd = addDays(parsedEnd, shiftDays);
    setWeekStart(formatDate(nextStart));
    setPeriodEnd(formatDate(nextEnd));
    setCustomStartInput(formatDate(nextStart));
    setCustomEndInput(formatDate(nextEnd));

    if (!currentUserId) {
      incrementGuestCounter(GUEST_REMINDER_PERIOD_ATTEMPTS_KEY);
    }
  };

  const goToPreviousWeek = () => {
    shiftPeriod(-1);
  };

  const goToNextWeek = () => {
    shiftPeriod(1);
  };

  const loadActiveProductsFromCloud = useCallback(
    async (ownerId: string, key: string): Promise<ActivePeriodProduct[] | null> => {
      if (!isSupabaseConfigured()) return null;
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user || data.user.id !== ownerId) return null;
      const metadata = (data.user.user_metadata || {}) as Record<string, unknown>;
      const rawByRange = metadata[ACTIVE_PRODUCTS_CLOUD_META_KEY];
      if (!rawByRange || typeof rawByRange !== "object") return null;
      const byRange = rawByRange as Record<string, unknown>;
      if (!(key in byRange)) return null;
      return normalizeActivePeriodProducts(byRange[key], "");
    },
    []
  );

  const saveActiveProductsToCloud = useCallback(
    async (ownerId: string, key: string, items: ActivePeriodProduct[]): Promise<void> => {
      if (!isSupabaseConfigured()) return;
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user || data.user.id !== ownerId) return;
      const metadata = (data.user.user_metadata || {}) as Record<string, unknown>;
      const rawByRange = metadata[ACTIVE_PRODUCTS_CLOUD_META_KEY];
      const byRange =
        rawByRange && typeof rawByRange === "object"
          ? { ...(rawByRange as Record<string, unknown>) }
          : {};
      byRange[key] = items.map((item) => ({
        id: item.id,
        name: item.name,
        scope: item.scope,
        untilDate: item.untilDate,
        prefer: item.prefer,
        note: item.note || "",
        hidden: item.hidden === true,
      }));
      const { error: updateError } = await supabase.auth.updateUser({
        data: {
          ...metadata,
          [ACTIVE_PRODUCTS_CLOUD_META_KEY]: byRange,
        },
      });
      if (updateError) {
        console.error("[menu] failed to save active products to cloud", updateError);
      }
    },
    []
  );

  const addActiveProduct = () => {
    const name = activeProductName.trim();
    if (!name) return;
    const normalizedName = name.toLowerCase();
    const existing = activeProducts.find((item) => (item.name || "").toLowerCase() === normalizedName);

    if (existing) {
      setActiveProducts((prev) =>
        prev.map((item) => (item.id === existing.id ? { ...item, name, prefer: true, note: item.note || "" } : item))
      );
      setExpandedActiveProductNoteId(existing.id);
    } else {
      const newId = crypto.randomUUID();
      setActiveProducts((prev) => [
        ...prev,
        {
          id: newId,
          name,
          scope: "in_period",
          untilDate: "",
          prefer: true,
          note: "",
          hidden: false,
        },
      ]);
      setExpandedActiveProductNoteId(newId);
    }

    appendProductSuggestions([name]);
    setActiveProductsSearch("");
    setActiveProductName("");
  };

  const removeActiveProduct = (id: string) => {
    setActiveProducts((prev) => prev.filter((item) => item.id !== id));
    setExpandedActiveProductNoteId((prev) => (prev === id ? null : prev));
    setActiveProductSavedNoteId((prev) => (prev === id ? null : prev));
    setActiveProductNoteDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const toggleActiveProductPriority = (id: string) => {
    setActiveProducts((prev) =>
      prev.map((item) => (item.id === id ? { ...item, prefer: !item.prefer } : item))
    );
  };

  const updateActiveProductNote = (id: string, note: string) => {
    const normalized = note.slice(0, ACTIVE_PRODUCT_NOTE_MAX_LENGTH);
    setActiveProducts((prev) => prev.map((item) => (item.id === id ? { ...item, note: normalized } : item)));
  };

  const getActiveProductNoteValue = (product: ActivePeriodProduct): string => {
    if (product.id in activeProductNoteDrafts) {
      return activeProductNoteDrafts[product.id] || "";
    }
    return product.note || "";
  };

  const handleActiveProductNoteDraftChange = (id: string, note: string) => {
    const normalized = note.slice(0, ACTIVE_PRODUCT_NOTE_MAX_LENGTH);
    setActiveProductNoteDrafts((prev) => ({ ...prev, [id]: normalized }));
  };

  const showActiveProductSavedHint = (id: string) => {
    setActiveProductSavedNoteId(id);
    if (typeof window !== "undefined") {
      if (activeProductSavedNoteTimerRef.current !== null) {
        window.clearTimeout(activeProductSavedNoteTimerRef.current);
      }
      activeProductSavedNoteTimerRef.current = window.setTimeout(() => {
        setActiveProductSavedNoteId((prev) => (prev === id ? null : prev));
        activeProductSavedNoteTimerRef.current = null;
      }, 1000);
    }
  };

  const handleActiveProductNoteBlur = (id: string) => {
    const product = activeProducts.find((item) => item.id === id);
    if (!product) return;

    const draftRaw = id in activeProductNoteDrafts ? activeProductNoteDrafts[id] : product.note || "";
    const draft = draftRaw.slice(0, ACTIVE_PRODUCT_NOTE_MAX_LENGTH);
    const current = product.note || "";
    if (draft !== current) {
      updateActiveProductNote(id, draft);
      showActiveProductSavedHint(id);
    }

    setActiveProductNoteDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

    setExpandedActiveProductNoteId((prev) => (prev === id ? null : prev));
  };

  const updateActiveProductUntilDate = (id: string, untilDate: string) => {
    setActiveProducts((prev) => prev.map((item) => (item.id === id ? { ...item, untilDate } : item)));
    setExpandedActiveProductNoteId((prev) => (prev === id ? null : prev));
  };

  const updateActiveProductScope = (id: string, scope: ActiveProductScope) => {
    setActiveProducts((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        if (scope === "until_date") {
          return { ...item, scope, untilDate: item.untilDate || formatDate(new Date()) };
        }
        return { ...item, scope };
      })
    );
  };

  const getActiveProductScopeLabel = (product: ActivePeriodProduct): string => {
    if (product.scope === "persistent") return t("menu.activeProducts.scopePersistent");
    if (product.scope === "until_date" && product.untilDate) {
      const parsed = parseDateSafe(product.untilDate);
      if (parsed) return t("menu.activeProducts.scopeUntilDateValue", { date: formatDisplayDate(parsed, locale) });
      return t("menu.activeProducts.scopeUntilDate");
    }
    return t("menu.activeProducts.scopeInMenu");
  };

  const handleAiMenuSuggestion = useCallback(async (prompt = "") => {
    try {
      window.dispatchEvent(
        new CustomEvent("planotto:menu-ai-status", {
          detail: { isLoading: true, message: "" },
        })
      );
      const peopleValues = Object.values(cellPeopleCount).filter((value) => Number.isFinite(value) && value > 0);
      const peopleCount = peopleValues.length > 0
        ? Math.max(1, Math.round(peopleValues.reduce((sum, value) => sum + value, 0) / peopleValues.length))
        : 2;
      const prioritizedProducts = activeProducts
        .filter((item) => item.prefer)
        .map((item) => item.name)
        .join(", ");
      let allergiesConstraint = "";
      let dislikesConstraint = "";
      if (isSupabaseConfigured()) {
        try {
          const supabase = getSupabaseClient();
          const { data } = await supabase.auth.getUser();
          const metadata = (data.user?.user_metadata || {}) as Record<string, unknown>;
          const allergies = parseItemsList(resolveUserMetaValue(metadata, "allergies", ""));
          const dislikes = parseItemsList(resolveUserMetaValue(metadata, "dislikes", ""));
          if (allergies.length > 0) {
            allergiesConstraint = t("menu.ai.constraints.allergies", {
              items: allergies.join(", "),
            });
          }
          if (dislikes.length > 0) {
            dislikesConstraint = t("menu.ai.constraints.dislikes", {
              items: dislikes.join(", "),
            });
          }
        } catch {
          // ignore profile metadata read errors for AI hint flow
        }
      }
      const pantryConstraint = pantry.length > 0
        ? t("menu.ai.constraints.pantryPriority")
        : "";
      const composedConstraints = [
        prompt.trim(),
        prioritizedProducts
          ? t("menu.ai.constraints.activeProducts", { items: prioritizedProducts })
          : "",
        allergiesConstraint,
        dislikesConstraint,
        pantryConstraint,
      ]
        .filter(Boolean)
        .join(" ");

      const data = await getMenuSuggestion({
        peopleCount,
        days: Math.max(1, visibleDayCount || periodDays),
        constraints: composedConstraints,
        newDishPercent: 40,
        recipes: recipes.map((recipe) => recipe.title).slice(0, 120),
      });

      const message = data.message || t("menu.ai.noSuggestion");
      window.dispatchEvent(
        new CustomEvent("planotto:menu-ai-status", {
          detail: { isLoading: false, message },
        })
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : t("menu.ai.failedToGetSuggestion");
      window.dispatchEvent(
        new CustomEvent("planotto:menu-ai-status", {
          detail: { isLoading: false, message: text },
        })
      );
    }
  }, [activeProducts, cellPeopleCount, pantry.length, periodDays, recipes, t, visibleDayCount]);

  const ensureArray = (items: MenuItem | MenuItem[] | undefined): MenuItem[] => {
    if (!items) return [];
    if (Array.isArray(items)) return items;
    return [items];
  };

  const ensureTextItemCompatibility = (item: MenuItem): MenuItem => {
    if (item.type === "text") {
      return {
        ...item,
        includeInShopping: item.includeInShopping ?? true,
        ingredients: item.ingredients || [],
        cooked: item.cooked ?? false,
      };
    }
    return item;
  };

  const normalizeMealData = (raw: unknown): Record<string, MenuItem[]> => {
    if (!raw || typeof raw !== "object") return {};
    const converted: Record<string, MenuItem[]> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const items = ensureArray(value as MenuItem | MenuItem[] | undefined);
      converted[key] = items.map((it) => ensureTextItemCompatibility(it));
    }
    return converted;
  };

  const loadRecipesFromLocal = () => {
    const storedRecipes = localStorage.getItem(RECIPES_STORAGE_KEY);
    if (!storedRecipes) {
      setRecipes([]);
      return;
    }

    try {
      setRecipes(JSON.parse(storedRecipes));
    } catch (e) {
      console.error("Failed to load recipes:", e);
      setRecipes([]);
    }
  };

  const getMenuSyncMessage = (error: unknown): string => {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    if (error && typeof error === "object") {
      const typed = error as { message?: unknown; code?: unknown };
      const message = typeof typed.message === "string" ? typed.message : "";
      const code = typeof typed.code === "string" ? typed.code : "";

      if (code === "42P01" || message.toLowerCase().includes("weekly_menus")) {
        return t("menu.errors.weeklyMenusTableMissing");
      }

      if (message) return message;
    }

    return t("menu.errors.saveFailed");
  };

  const getDisplayText = (items: MenuItem[] | undefined): string => {
    if (!items || items.length === 0) return "";
    const item = items[0];
    if (item.type === "recipe" && item.recipeId) {
      const recipe = recipes.find((r) => r.id === item.recipeId);
      return recipe ? recipe.title : item.value || "";
    }
    return item.value || "";
  };

  const getMenuItemTitleForExport = (item: MenuItem): string => {
    if (item.type === "recipe" && item.recipeId) {
      const recipe = recipes.find((entry) => entry.id === item.recipeId);
      return String(recipe?.title || item.value || t("menu.fallback.recipeTitle")).trim();
    }
    return String(item.value || "").trim();
  };

  const getRecipeForPdfExport = (recipeId: string): Recipe | null => {
    const fromState = recipes.find((entry) => entry.id === recipeId);
    if (fromState) return fromState;
    return getRecipeFromLocalStorageById(recipeId);
  };

  const formatIngredientForPdf = (ingredient: Ingredient): string => {
    const ingredientName = String(ingredient.name || "").trim();
    if (!ingredientName) return "";
    const resolvedUnitId = normalizeUnitId(
      ingredient.unitId || ingredient.unit_id || ingredient.unit || DEFAULT_UNIT_ID,
      DEFAULT_UNIT_ID
    );
    if (isTasteLikeUnit(resolvedUnitId)) {
      return `${ingredientName} — ${t("recipes.detail.taste")}`;
    }
    const unitLabel = getUnitLabelById(resolvedUnitId, locale);
    return `${ingredient.amount} ${unitLabel} ${ingredientName}`.trim();
  };

  const findCookingTimeLabel = (recipe: Recipe): string | undefined => {
    const source = [...(recipe.tags || []), ...(recipe.categories || [])].map((item) => String(item || "").trim());
    return source.find((value) => /\d+\s*(мин|min|ч|час|hour|hr)/i.test(value));
  };

  const isDayInPast = (dayKey: string): boolean => {
    const currentDate = parseDateSafe(dayKey);
    if (!currentDate) return false;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    currentDate.setHours(0, 0, 0, 0);

    return currentDate < today;
  };

  const getDefaultCookedStatus = (dayKey: string, itemId?: string): boolean => {
    void dayKey;
    if (itemId && cookedStatus[itemId] !== undefined) return cookedStatus[itemId];
    return false;
  };

  const getEffectivePeopleCount = (key: string) => cellPeopleCount[key] || 1;

  const hasRecipeAvailable = (recipeId: string): boolean => {
    if (recipes.some((item) => item.id === recipeId)) return true;
    if (typeof window === "undefined") return false;

    try {
      const raw = localStorage.getItem(RECIPES_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as Array<{ id?: string }>;
      return Array.isArray(parsed) && parsed.some((item) => item?.id === recipeId);
    } catch {
      return false;
    }
  };

  const getMenuItemIngredients = (cellKey: string, menuItem: MenuItem): Ingredient[] => {
    if (menuItem.ingredients && menuItem.ingredients.length > 0) {
      return menuItem.ingredients.filter((ingredient) => isCountableIngredient(ingredient));
    }

    if (menuItem.type !== "recipe" || !menuItem.recipeId) {
      return [];
    }

    const recipe = recipes.find((item) => item.id === menuItem.recipeId);
    if (!recipe?.ingredients || recipe.ingredients.length === 0) {
      return [];
    }

    const peopleCount = getEffectivePeopleCount(cellKey);
    const baseServings = recipe.servings && recipe.servings > 0 ? recipe.servings : 2;
    const scale = peopleCount / baseServings;

    return recipe.ingredients
      .filter((ingredient) => isCountableIngredient(ingredient))
      .map((ingredient) => ({
        ...ingredient,
        amount: ingredient.amount * scale,
      }));
  };

  const updateCellPeopleCount = (key: string, count: number) => {
    setCellPeopleCount((prev) => {
      const updated = { ...prev };
      if (count <= 0) delete updated[key];
      else updated[key] = count;
      return updated;
    });
  };

  const deductFromPantry = (ingredients: Ingredient[]) => {
    setPantry((prev) => {
      const updated = [...prev];
      ingredients.forEach((ingredient) => {
        if (!isCountableIngredient(ingredient)) return;
        const normalized = ingredient.name.toLowerCase().trim();
        const idx = updated.findIndex(
          (item) => item.name.toLowerCase().trim() === normalized && item.unit === ingredient.unit
        );
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], amount: Math.max(0, updated[idx].amount - ingredient.amount) };
        }
      });
      return updated;
    });
  };

  const markMenuItemCooked = (cellKey: string, index: number, deductPantry = true) => {
    const items = mealData[cellKey];
    if (!items || !items[index]) return;

    const menuItem = items[index];
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], cooked: true };

    setMealData((prev) => ({ ...prev, [cellKey]: updatedItems }));
    setCookedStatus((prev) => ({ ...prev, [menuItem.id]: true }));

    if (deductPantry) {
      const ingredientsToDeduct = getMenuItemIngredients(cellKey, menuItem);
      if (ingredientsToDeduct.length > 0) {
        deductFromPantry(ingredientsToDeduct);
      }
    }
  };

  useEffect(() => {
    localStorage.setItem(
      RANGE_STATE_KEY,
      JSON.stringify({
        start: weekStart,
        end: periodEnd,
        preset: periodPreset,
      })
    );
  }, [weekStart, periodEnd, periodPreset]);

  useEffect(() => {
    const storedRangeState = localStorage.getItem(RANGE_STATE_KEY);
    if (storedRangeState) {
      try {
        const parsed = JSON.parse(storedRangeState) as { start?: string; end?: string; preset?: PeriodPreset };
        if (parsed.start && parseDateSafe(parsed.start)) setWeekStart(parsed.start);
        if (parsed.end && parseDateSafe(parsed.end)) setPeriodEnd(parsed.end);
        if (parsed.preset) setPeriodPreset(parsed.preset);
        if (parsed.start) setCustomStartInput(parsed.start);
        if (parsed.end) setCustomEndInput(parsed.end);
      } catch {
        // ignore corrupted local range state
      }
    }
  }, []);

  useEffect(() => {
    const storedRecipes = localStorage.getItem(RECIPES_STORAGE_KEY);
    if (storedRecipes) {
      try {
        setRecipes(JSON.parse(storedRecipes));
      } catch (e) {
        console.error("Failed to load recipes:", e);
        setRecipes([]);
      }
    } else {
      setRecipes([]);
    }
  }, []);

  useEffect(() => {
    const storedPantry = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (storedPantry) {
      try {
        const pantryData = JSON.parse(storedPantry);
        setPantry(Array.isArray(pantryData) ? pantryData : []);
      } catch (e) {
        console.error("Failed to load pantry:", e);
        setPantry([]);
      }
    } else {
      setPantry([]);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    if (!isSupabaseConfigured()) {
      setCurrentUserId(null);
      setAuthResolved(true);
      return () => {
        isMounted = false;
      };
    }

    getCurrentUserId()
      .then((userId) => {
        if (isMounted) setCurrentUserId(userId);
      })
      .catch(() => {
        if (isMounted) setCurrentUserId(null);
      })
      .finally(() => {
        if (isMounted) setAuthResolved(true);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    if (!authResolved) return () => { isCancelled = true; };
    if (!currentUserId || !isSupabaseConfigured()) {
      setProfilePlanDaysPreference("all");
      return () => {
        isCancelled = true;
      };
    }

    const supabase = getSupabaseClient();
    supabase.auth.getUser()
      .then(({ data, error }) => {
        if (isCancelled || error) return;
        const metadata = (data.user?.user_metadata || {}) as Record<string, unknown>;
        const preference = normalizePlanDaysPreference(resolveUserMetaValue(metadata, "plan_days", "all"));
        const mealsPerDay = normalizeMealsPerDayPreference(resolveUserMetaValue(metadata, "meals_per_day", "3"));
        setProfilePlanDaysPreference(preference);
        setProfileMealsPerDayPreference(mealsPerDay);
      })
      .catch(() => {
        if (!isCancelled) {
          setProfilePlanDaysPreference("all");
          setProfileMealsPerDayPreference("3");
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [authResolved, currentUserId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(planningDaysStorageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const normalized = normalizePlanningDayKeys(parsed, dayKeys);
        if (normalized.length > 0) {
          setPlanningDayKeys(normalized);
          return;
        }
      } catch {
        // ignore broken selected planning days
      }
    }
    setPlanningDayKeys(defaultPlanningDayKeys);
  }, [dayKeys, defaultPlanningDayKeys, planningDaysStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (planningDayKeys.length === 0) return;
    window.localStorage.setItem(planningDaysStorageKey, JSON.stringify(planningDayKeys));
  }, [planningDayKeys, planningDaysStorageKey]);

  useEffect(() => {
    let isCancelled = false;

    if (!hasLoaded || !authResolved) return () => { isCancelled = true; };
    if (!currentUserId || !isSupabaseConfigured()) {
      setActiveProductsCloudHydrated(true);
      return () => {
        isCancelled = true;
      };
    }

    setActiveProductsCloudHydrated(false);
    loadActiveProductsFromCloud(currentUserId, rangeKey)
      .then((cloudProducts) => {
        if (isCancelled) return;
        if (cloudProducts !== null) {
          setActiveProducts(cloudProducts);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          console.error("[menu] failed to load active products from cloud", error);
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setActiveProductsCloudHydrated(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [authResolved, currentUserId, hasLoaded, loadActiveProductsFromCloud, rangeKey]);

  useEffect(() => {
    if (!authResolved || currentUserId) return;
    if (guestVisitTrackedRef.current) return;

    guestVisitTrackedRef.current = true;
    incrementGuestCounter(GUEST_REMINDER_VISITS_KEY);

    if (typeof window !== "undefined" && window.sessionStorage.getItem(GUEST_REMINDER_PENDING_KEY) === "1") {
      window.sessionStorage.removeItem(GUEST_REMINDER_PENDING_KEY);
      setGuestReminderStrong(shouldUseStrongGuestReminder(recipes.length));
      setShowGuestReminder(true);
    }
  }, [authResolved, currentUserId, recipes.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (showMenuAddedNotice) return;

    const pending = window.sessionStorage.getItem(GUEST_REMINDER_PENDING_KEY) === "1";
    if (!pending) return;

    window.sessionStorage.removeItem(GUEST_REMINDER_PENDING_KEY);
    setGuestReminderStrong(shouldUseStrongGuestReminder(recipes.length));
    setShowGuestReminder(true);
  }, [recipes.length, showMenuAddedNotice]);

  useEffect(() => {
    const parseLegacyCounts = (): Record<string, number> => {
      const storedCounts = localStorage.getItem(cellPeopleCountKey);
      if (!storedCounts) return {};
      try {
        return normalizePeopleCountMap(JSON.parse(storedCounts));
      } catch (e) {
        console.error("Failed to load cell people count:", e);
        return {};
      }
    };

    const parseLegacyCooked = (): Record<string, boolean> => {
      const storedCookedStatus = localStorage.getItem(cookedStatusKey);
      if (!storedCookedStatus) return {};
      try {
        return normalizeCookedStatusMap(JSON.parse(storedCookedStatus));
      } catch (e) {
        console.error("Failed to load cooked status:", e);
        return {};
      }
    };

    const legacyCounts = parseLegacyCounts();
    const legacyCooked = parseLegacyCooked();
    const storedMenu = localStorage.getItem(menuStorageKey);
    const parsedBundle = parseMenuBundleFromStorage(
      storedMenu,
      legacyCounts,
      legacyCooked,
      defaultMenuName
    );
    const initialActiveId = parsedBundle.activeMenuId;
    const initialActiveMenu =
      parsedBundle.menus.find((menu) => menu.id === initialActiveId) || parsedBundle.menus[0];

    setMenuProfiles(parsedBundle.menus);
    setActiveMenuId(initialActiveId);
    setNameDrafts(buildNameDrafts(parsedBundle.menus));
    setMergeShoppingWithAllMenus(localStorage.getItem(getMergeShoppingKey(rangeKey)) === "1");
    const storedAddPromptPreference = localStorage.getItem(MENU_ADD_TO_MENU_PROMPT_KEY);
    setShowAddRecipePromptInRecipes(storedAddPromptPreference !== "0");
    setMealData(initialActiveMenu?.mealData || {});
    setCellPeopleCount(initialActiveMenu?.cellPeopleCount || {});
    setCookedStatus(initialActiveMenu?.cookedStatus || {});

    const labelsFromData = Array.from(
      new Set(
        Object.keys(initialActiveMenu?.mealData || {})
          .map((cellKey) => splitCellKey(cellKey)?.mealLabel || "")
          .filter(Boolean)
      )
    );
    if (labelsFromData.length > 0) {
      setMealSlots((prev) => {
        const existing = new Set(prev.map((slot) => slot.name.toLocaleLowerCase(activeLocale)));
        const missing = labelsFromData.filter(
          (label) => !existing.has(label.toLocaleLowerCase(activeLocale))
        );
        if (missing.length === 0) return prev;
        const nextBase = [...prev];
        missing.forEach((name) => {
          nextBase.push({
            id: crypto.randomUUID(),
            name,
            visible: true,
            order: nextBase.length,
          });
        });
        return nextBase;
      });
    }

    const storedActiveProducts = localStorage.getItem(activeProductsKey);
    if (storedActiveProducts) {
      try {
        const parsed = JSON.parse(storedActiveProducts);
        setActiveProducts(normalizeActivePeriodProducts(parsed, ""));
      } catch (e) {
        console.error("Failed to load active products:", e);
        setActiveProducts([]);
      }
    } else {
      setActiveProducts([]);
    }

    setExpandedActiveProductNoteId(null);
    setActiveProductsCloudHydrated(false);
    setShowMenuSettingsDialog(false);
    setShowMealSettingsDialog(false);
    setIsCreateMenuDialogOpen(false);
    setPendingDeleteMenuId(null);
    setHasLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildNameDrafts, defaultMenuName, getMergeShoppingKey, rangeKey]);

  useEffect(() => {
    if (!hasLoaded || !activeMenuId) return;
    const target = menuProfiles.find((menu) => menu.id === activeMenuId);
    if (!target) return;

    setMealData((prev) => (prev === target.mealData ? prev : target.mealData));
    setCellPeopleCount((prev) =>
      prev === target.cellPeopleCount ? prev : target.cellPeopleCount
    );
    setCookedStatus((prev) => (prev === target.cookedStatus ? prev : target.cookedStatus));
  }, [activeMenuId, hasLoaded, menuProfiles]);

  useEffect(() => {
    if (!hasLoaded || !activeMenuId) return;
    persistMenuSnapshot(mealData, cellPeopleCount, cookedStatus, activeMenuId);
  }, [
    activeMenuId,
    cellPeopleCount,
    cookedStatus,
    hasLoaded,
    mealData,
    persistMenuSnapshot,
    rangeKey,
  ]);

  useEffect(() => {
    if (!hasLoaded || typeof window === "undefined") return;
    if (profileGoal === "explore") {
      setShowFirstVisitOnboarding(false);
      return;
    }
    if (forceFirstFromQuery) {
      localStorage.removeItem(MENU_FIRST_VISIT_ONBOARDING_KEY);
      setForcedOnboardingFlow(true);
      setShowFirstVisitOnboarding(true);
      return;
    }

    const isDismissed = localStorage.getItem(MENU_FIRST_VISIT_ONBOARDING_KEY) === "1";
    if (menuMode === "mine" && allMenusEmpty) {
      setShowFirstVisitOnboarding(false);
      return;
    }
    if (menuMode === "mine" && recipes.length === 0 && !isDismissed) {
      setShowFirstVisitOnboarding(true);
    }
  }, [allMenusEmpty, forceFirstFromQuery, hasLoaded, menuMode, profileGoal, recipes.length, router]);

  useEffect(() => {
    if (profileGoal === "explore") {
      setShowCalendarInlineHint(false);
      setShowFirstVisitOnboarding(false);
      return;
    }
    if (forceFirstFromQuery) return;
    if (recipes.length > 0 && !forcedOnboardingFlow) {
      setShowCalendarInlineHint(false);
      setShowFirstVisitOnboarding(false);
      return;
    }
    if (typeof window === "undefined") return;
    const inlineDismissed = localStorage.getItem(MENU_INLINE_HINT_DISMISSED_KEY) === "1";
    if (inlineDismissed) {
      setShowCalendarInlineHint(false);
    }
  }, [forceFirstFromQuery, forcedOnboardingFlow, profileGoal, recipes.length]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(cellPeopleCountKey, JSON.stringify(cellPeopleCount));
  }, [cellPeopleCount, cellPeopleCountKey, hasLoaded, rangeKey]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(cookedStatusKey, JSON.stringify(cookedStatus));
  }, [cookedStatus, cookedStatusKey, hasLoaded, rangeKey]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(activeProductsKey, JSON.stringify(activeProducts));
  }, [activeProducts, activeProductsKey, hasLoaded, rangeKey]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(getMergeShoppingKey(rangeKey), mergeShoppingWithAllMenus ? "1" : "0");
  }, [getMergeShoppingKey, hasLoaded, mergeShoppingWithAllMenus, rangeKey]);

  useEffect(() => {
    if (!hasLoaded || typeof window === "undefined") return;
    localStorage.setItem(MENU_ADD_TO_MENU_PROMPT_KEY, showAddRecipePromptInRecipes ? "1" : "0");
  }, [hasLoaded, showAddRecipePromptInRecipes]);

  useEffect(() => {
    if (!hasLoaded || !authResolved || !currentUserId || !activeProductsCloudHydrated) return;
    if (!isSupabaseConfigured()) return;
    if (typeof window === "undefined") return;

    if (activeProductsSaveTimerRef.current !== null) {
      window.clearTimeout(activeProductsSaveTimerRef.current);
    }

    activeProductsSaveTimerRef.current = window.setTimeout(() => {
      saveActiveProductsToCloud(currentUserId, rangeKey, activeProducts).catch((error) => {
        console.error("[menu] failed to persist active products", error);
      });
    }, 450);

    return () => {
      if (activeProductsSaveTimerRef.current !== null) {
        window.clearTimeout(activeProductsSaveTimerRef.current);
        activeProductsSaveTimerRef.current = null;
      }
    };
  }, [
    activeProducts,
    activeProductsCloudHydrated,
    authResolved,
    currentUserId,
    hasLoaded,
    rangeKey,
    saveActiveProductsToCloud,
  ]);

  useEffect(() => {
    return () => {
      if (activeProductsSaveTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(activeProductsSaveTimerRef.current);
        activeProductsSaveTimerRef.current = null;
      }
      if (activeProductSavedNoteTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(activeProductSavedNoteTimerRef.current);
        activeProductSavedNoteTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(pantry));
  }, [pantry, hasLoaded]);

  useEffect(() => {
    const onAssistantAskMenu = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      const prompt = typeof detail?.prompt === "string" ? detail.prompt : "";
      handleAiMenuSuggestion(prompt);
    };

    window.addEventListener("planotto:request-menu-ai", onAssistantAskMenu as EventListener);
    return () => {
      window.removeEventListener("planotto:request-menu-ai", onAssistantAskMenu as EventListener);
    };
  }, [handleAiMenuSuggestion]);

  useEffect(() => {
    if (!hasLoaded) return;
    const recipeId = searchParams.get("recipe");
    if (!recipeId) return;
    const titleFromQuery = (searchParams.get("title") || "").trim();
    const mealFromQuery = (searchParams.get("meal") || "").trim();
    const selectedRecipe = recipes.find((r) => r.id === recipeId) as (Recipe & { tags?: string[] }) | undefined;

    let selectedTitle = selectedRecipe?.title || titleFromQuery;
    if (!selectedTitle && typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(RECIPES_STORAGE_KEY);
        if (raw) {
          const cached = JSON.parse(raw) as Array<{ id?: string; title?: string }>;
          const fromCache = cached.find((item) => item?.id === recipeId)?.title;
          if (fromCache) selectedTitle = fromCache;
        }
      } catch {
        // ignore corrupted local recipes cache
      }
    }
    if (!selectedTitle) selectedTitle = t("menu.fallback.recipeTitle");

    const todayKey = formatDate(new Date());
    const tomorrowKey = formatDate(addDays(new Date(), 1));
    const candidateDayKeys = visibleDayKeys.length > 0 ? visibleDayKeys : dayKeys;
    const selectedDay = candidateDayKeys.includes(tomorrowKey)
      ? tomorrowKey
      : candidateDayKeys.includes(todayKey)
        ? todayKey
        : candidateDayKeys[0];
    if (!selectedDay) return;

    const preferredMealType = resolvePreferredMealTypeForRecipe(selectedRecipe, mealFromQuery);
    const dayMeals = getAllMealsForDay(selectedDay);
    const preferredMeal = selectMealLabelByType(preferredMealType, dayMeals, defaultDayMeals);
    const targetCellKey = getCellKey(selectedDay, preferredMeal);
    const selectedDate = parseDateSafe(selectedDay);
    const weekdayLabel = getWeekdayLong(selectedDay, locale) || getWeekdayLabel(selectedDay, locale);
    const dayLabelWithDate = selectedDate ? `${weekdayLabel}, ${formatDisplayDate(selectedDate, locale)}` : weekdayLabel;

    closeAddEditDialog();
    setShowMenuAddedNotice(false);
    setMenuAddedHasIngredients(false);

    setPendingRecipeForMenu(recipeId);
    setQuickRecipeConfirm({
      recipeId,
      recipeTitle: selectedTitle,
      cellKey: targetCellKey,
      dayLabel: dayLabelWithDate,
      mealLabel: preferredMeal.toLocaleLowerCase(activeLocale),
    });

    router.replace("/menu");
  }, [activeLocale, dayKeys, defaultDayMeals, getAllMealsForDay, hasLoaded, locale, recipes, router, searchParams, t, visibleDayKeys]);

  const handleSelectMenuProfile = (menuId: string) => {
    if (!menuId || menuId === activeMenuId) return;
    const target = menuProfiles.find((menu) => menu.id === menuId);
    if (!target) return;
    setActiveMenuId(menuId);
  };

  const saveMenuName = (menuId: string) => {
    const target = menuProfiles.find((menu) => menu.id === menuId);
    if (!target) return;

    const rawDraft = nameDrafts[menuId] || target.name;
    const normalized = normalizeMenuProfileName(rawDraft);
    if (!normalized) {
      setNameDrafts((prev) => ({ ...prev, [menuId]: target.name }));
      return;
    }
    if (normalized === target.name) return;

    const duplicate = menuProfiles.some(
      (menu) => menu.id !== menuId && menu.name.toLocaleLowerCase(activeLocale) === normalized.toLocaleLowerCase(activeLocale)
    );
    if (duplicate) return;

    const nextMenus = menuProfiles.map((menu) => (menu.id === menuId ? { ...menu, name: normalized } : menu));
    persistMenuBundleSnapshot(nextMenus, activeMenuId);
    setMenuProfiles(nextMenus);
    setNameDrafts(buildNameDrafts(nextMenus));
  };

  const demoMenuTemplates = useMemo<DemoMenuTemplate[]>(
    () => [
      {
        id: "quick",
        title: t("menu.templates.quick.title"),
        description: t("menu.templates.quick.description"),
        meals: {
          breakfast: [
            t("menu.templates.dishes.omeletVegetables"),
            t("menu.templates.dishes.yogurtGranola"),
            t("menu.templates.dishes.oatmealFruit"),
          ],
          lunch: [
            t("menu.templates.dishes.tunaSalad"),
            t("menu.templates.dishes.turkeySandwich"),
            t("menu.templates.dishes.buckwheatMushrooms"),
          ],
          dinner: [
            t("menu.templates.dishes.pastaTomato"),
            t("menu.templates.dishes.friedRiceEgg"),
            t("menu.templates.dishes.riceVegetables"),
          ],
        },
      },
      {
        id: "family",
        title: t("menu.templates.family.title"),
        description: t("menu.templates.family.description"),
        meals: {
          breakfast: [
            t("menu.templates.dishes.crepesMilk"),
            t("menu.templates.dishes.oladiKefir"),
            t("menu.templates.dishes.oatmealFruit"),
          ],
          lunch: [
            t("menu.templates.dishes.chickenNoodleSoup"),
            t("menu.templates.dishes.chickenRice"),
            t("menu.templates.dishes.vegetableSoup"),
          ],
          dinner: [
            t("menu.templates.dishes.bakedFishPotatoes"),
            t("menu.templates.dishes.mashedPotatoes"),
            t("menu.templates.dishes.pastaTuna"),
          ],
        },
      },
      {
        id: "budget",
        title: t("menu.templates.budget.title"),
        description: t("menu.templates.budget.description"),
        meals: {
          breakfast: [
            t("menu.templates.dishes.oatmealFruit"),
            t("menu.templates.dishes.crepesMilk"),
            t("menu.templates.dishes.yogurtGranola"),
          ],
          lunch: [
            t("menu.templates.dishes.lentilSoup"),
            t("menu.templates.dishes.buckwheatMushrooms"),
            t("menu.templates.dishes.vegetableSoup"),
          ],
          dinner: [
            t("menu.templates.dishes.riceVegetables"),
            t("menu.templates.dishes.friedRiceEgg"),
            t("menu.templates.dishes.pastaTomato"),
          ],
        },
      },
    ],
    [t]
  );

  const buildUniqueMenuName = useCallback(
    (baseName: string): string => {
      const normalized = normalizeMenuProfileName(baseName) || defaultMenuName;
      const names = new Set(menuProfiles.map((menu) => menu.name.toLocaleLowerCase(activeLocale)));
      if (!names.has(normalized.toLocaleLowerCase(activeLocale))) return normalized;

      let index = 2;
      let candidate = `${normalized} ${index}`;
      while (names.has(candidate.toLocaleLowerCase(activeLocale))) {
        index += 1;
        candidate = `${normalized} ${index}`;
      }
      return candidate;
    },
    [activeLocale, defaultMenuName, menuProfiles]
  );

  const buildTemplateMealData = useCallback(
    (template: DemoMenuTemplate): Record<string, MenuItem[]> => {
      const nextMealData: Record<string, MenuItem[]> = {};

      visibleDayKeys.forEach((dayKey, dayIndex) => {
        const dayMeals = getDayMeals(dayKey);
        (["breakfast", "lunch", "dinner"] as const).forEach((mealType) => {
          const options = template.meals[mealType];
          if (!Array.isArray(options) || options.length === 0) return;
          const dish = options[dayIndex % options.length];
          if (!dish) return;

          const mealLabel = selectMealLabelByType(mealType, dayMeals, defaultDayMeals);
          const cellKey = getCellKey(dayKey, mealLabel);
          const entry: MenuItem = {
            id: crypto.randomUUID(),
            type: "text",
            value: dish,
            includeInShopping: true,
            ingredients: [],
            cooked: false,
          };
          nextMealData[cellKey] = [...(nextMealData[cellKey] || []), entry];
        });
      });

      return nextMealData;
    },
    [defaultDayMeals, getDayMeals, visibleDayKeys]
  );

  const applyDemoMenuTemplate = async (templateId: DemoMenuTemplateId) => {
    const template = demoMenuTemplates.find((item) => item.id === templateId);
    if (!template) return;

    const templateMealData = buildTemplateMealData(template);
    const templateMenuName = buildUniqueMenuName(template.title);
    const replaceActiveMenu = !canUseMultipleMenus || (menuProfiles.length <= 1 && allMenusEmpty);

    if (!allMenusEmpty && replaceActiveMenu) {
      const confirmed = await confirm({ message: t("menu.templates.replaceConfirm") });
      if (!confirmed) return;
    }

    if (replaceActiveMenu) {
      const targetId = activeMenuId || menuProfiles[0]?.id;
      if (!targetId) return;
      const nextMenus = menuProfiles.map((menu) =>
        menu.id === targetId
          ? {
              ...menu,
              name: templateMenuName,
              mealData: templateMealData,
              cellPeopleCount: {},
              cookedStatus: {},
            }
          : menu
      );
      persistMenuBundleSnapshot(nextMenus, targetId);
      setMenuProfiles(nextMenus);
      setActiveMenuId(targetId);
      setNameDrafts(buildNameDrafts(nextMenus));
      setMealData(templateMealData);
      setCellPeopleCount({});
      setCookedStatus({});
      setShowMenuTemplatesPanel(false);
      setMenuSyncError("");
      return;
    }

    const created = createMenuProfileState(templateMenuName);
    const nextMenu = {
      ...created,
      mealData: templateMealData,
      cellPeopleCount: {},
      cookedStatus: {},
    };
    const nextMenus = [...menuProfiles, nextMenu];
    persistMenuBundleSnapshot(nextMenus, nextMenu.id);
    setMenuProfiles(nextMenus);
    setActiveMenuId(nextMenu.id);
    setNameDrafts(buildNameDrafts(nextMenus));
    setMealData(templateMealData);
    setCellPeopleCount({});
    setCookedStatus({});
    setShowMenuTemplatesPanel(false);
    setMenuSyncError("");
  };

  const addMenu = () => {
    if (additionalMenusLocked) {
      setMenuSyncError(t("subscription.locks.multipleMenus"));
      setIsCreateMenuDialogOpen(false);
      return;
    }

    const normalized = normalizeMenuProfileName(newMenuNameDraft);
    if (!normalized) return;
    const duplicate = menuProfiles.some(
      (menu) => menu.name.toLocaleLowerCase(activeLocale) === normalized.toLocaleLowerCase(activeLocale)
    );
    if (duplicate) return;

    const created = createMenuProfileState(normalized);
    const nextMenus = [...menuProfiles, created];
    const nextActiveId = activeMenuId || created.id;
    persistMenuBundleSnapshot(nextMenus, nextActiveId);
    setMenuProfiles(nextMenus);
    setActiveMenuId(nextActiveId);
    setNameDrafts(buildNameDrafts(nextMenus));
    setNewMenuNameDraft("");
    setIsCreateMenuDialogOpen(false);
    setMenuSyncError("");
  };

  const requestRemoveMenu = (menuId: string) => {
    if (menuProfiles.length <= 1) return;
    setPendingDeleteMenuId(menuId);
  };

  const removeMenu = (menuId: string) => {
    if (menuProfiles.length <= 1) return;
    const target = menuProfiles.find((menu) => menu.id === menuId);
    if (!target) return;

    const nextMenus = menuProfiles.filter((menu) => menu.id !== menuId);
    if (nextMenus.length === 0) return;
    const nextActiveMenuId = activeMenuId === menuId ? nextMenus[0].id : activeMenuId;

    persistMenuBundleSnapshot(nextMenus, nextActiveMenuId);
    setMenuProfiles(nextMenus);
    setActiveMenuId(nextActiveMenuId);
    setNameDrafts(buildNameDrafts(nextMenus));
    setPendingDeleteMenuId(null);
  };

  const toggleMealVisibility = (slotId: string) => {
    setMealSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, visible: !slot.visible } : slot)));
  };

  const renameMealSlot = (slotId: string, nextRawName: string) => {
    const normalized = normalizeMealSlotName(nextRawName);
    const current = mealSlots.find((slot) => slot.id === slotId);
    if (!current || !normalized || normalized === current.name) return;

    const exists = mealSlots.some(
      (slot) => slot.id !== slotId && slot.name.toLocaleLowerCase(activeLocale) === normalized.toLocaleLowerCase(activeLocale)
    );
    if (exists) return;

    const nextMenus = migrateMealNameInMenus(menuProfiles, current.name, normalized);
    persistMenuBundleSnapshot(nextMenus, activeMenuId);
    setMenuProfiles(nextMenus);
    setMealSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, name: normalized } : slot)));
  };

  const moveMealSlot = (slotId: string, direction: -1 | 1) => {
    setMealSlots((prev) => {
      const ordered = [...prev].sort((a, b) => a.order - b.order);
      const index = ordered.findIndex((slot) => slot.id === slotId);
      if (index < 0) return prev;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= ordered.length) return prev;
      const swapped = [...ordered];
      [swapped[index], swapped[nextIndex]] = [swapped[nextIndex], swapped[index]];
      return swapped.map((slot, idx) => ({ ...slot, order: idx }));
    });
  };

  const addMealSlot = () => {
    const normalized = normalizeMealSlotName(newMealSlotName);
    if (!normalized) return;
    const exists = mealSlots.some(
      (slot) => slot.name.toLocaleLowerCase(activeLocale) === normalized.toLocaleLowerCase(activeLocale)
    );
    if (exists) return;

    const nextOrder = mealSlots.length;
    setMealSlots((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: normalized, visible: true, order: nextOrder },
    ]);
    setNewMealSlotName("");
  };

  const closeMealSettingsDialog = () => {
    setShowMealSettingsDialog(false);
    setSaveMealSlotsAsDefault(false);
    setNewMealSlotName("");
  };

  const handleMealSettingsDone = () => {
    if (saveMealSlotsAsDefault && typeof window !== "undefined") {
      localStorage.setItem(MEAL_STRUCTURE_DEFAULT_SETTINGS_KEY, JSON.stringify(mealSlots));
    }
    closeMealSettingsDialog();
  };

  const generateShoppingListForMenu = (menuId: string) => {
    const menuProfilesWithCurrentState = menuProfiles.map((menu) => {
      if (menu.id !== activeMenuId) return menu;
      return {
        ...menu,
        mealData,
        cellPeopleCount,
        cookedStatus,
      };
    });
    const targetMenu = menuProfilesWithCurrentState.find((menu) => menu.id === menuId);
    if (!targetMenu) return;
    const sourceMenus = mergeShoppingWithAllMenus ? menuProfilesWithCurrentState : [targetMenu];

    const dishNames = sourceMenus
      .flatMap((menu) => Object.values(menu.mealData))
      .map((item) => getDisplayText(item))
      .filter((name) => name.trim() !== "");

    if (dishNames.length === 0) return;

    persistMenuBundleSnapshot(menuProfilesWithCurrentState, activeMenuId);
    sessionStorage.setItem("menuDishes", JSON.stringify(dishNames));
    sessionStorage.setItem("cellPeopleCount", JSON.stringify(targetMenu.cellPeopleCount));
    sessionStorage.setItem("shoppingSelectedMenuId", mergeShoppingWithAllMenus ? "merged" : menuId);
    sessionStorage.setItem(
      "shoppingSelectedMenuName",
      mergeShoppingWithAllMenus ? t("menu.shopping.allMenusPeriod") : targetMenu.name
    );
    sessionStorage.setItem("shoppingUseMergedMenus", mergeShoppingWithAllMenus ? "1" : "0");
    sessionStorage.setItem("shoppingListUpdatedFromMenu", "1");
    router.push("/shopping-list");
  };

  const generateShoppingList = () => {
    if (!activeMenuId) return;
    generateShoppingListForMenu(activeMenuId);
  };

  const handleAddItemClick = (key: string) => {
    closeDropdownMenu();

    setAddingItemCell(key);
    setEditingItem(null);

    setNewItemType("recipe");
    setNewItemText("");
    setNewItemRecipeId("");
    setNewItemIncludeInShopping(true);
    setNewItemIngredients([{ id: crypto.randomUUID(), name: "", amount: 0, unitId: DEFAULT_UNIT_ID, unit: DEFAULT_UNIT }]);

    const count = getEffectivePeopleCount(key);
    setNewItemPeopleCount(count);
    setPeopleInput(count.toString());

    setRecipeCategoryFilter(RECIPE_CATEGORY_FILTER_ALL);
  };

  const handleQuickRecipeAdd = () => {
    if (!quickRecipeConfirm) return;

    const recipeFromState = recipes.find((item) => item.id === quickRecipeConfirm.recipeId);
    const recipeFromCache = recipeFromState || getRecipeFromLocalStorageById(quickRecipeConfirm.recipeId);
    const peopleCount = getEffectivePeopleCount(quickRecipeConfirm.cellKey);
    const baseServings = recipeFromCache?.servings && recipeFromCache.servings > 0 ? recipeFromCache.servings : 2;
    const scale = peopleCount / baseServings;
    const scaledIngredients =
      recipeFromCache?.ingredients
        ?.filter((ingredient) => ingredient.name.trim().length > 0 && ingredient.amount > 0)
        .map((ingredient) => ({
          ...ingredient,
          amount: ingredient.amount * scale,
        })) || [];

    const newItem: MenuItem = {
      id: crypto.randomUUID(),
      type: "recipe",
      recipeId: quickRecipeConfirm.recipeId,
      value: quickRecipeConfirm.recipeTitle,
      ingredients: scaledIngredients,
      cooked: false,
    };

    const updatedMealData = {
      ...mealData,
      [quickRecipeConfirm.cellKey]: [...(mealData[quickRecipeConfirm.cellKey] || []), newItem],
    };
    persistMenuSnapshot(updatedMealData);
    setMealData(updatedMealData);
    setMenuAddedHasIngredients(hasCountableIngredients(scaledIngredients));

    setQuickRecipeConfirm(null);
    setPendingRecipeForMenu(null);
    setShowMenuAddedNotice(true);

    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("planottoHighlightShoppingNav", "1");
      window.sessionStorage.setItem("shoppingFromMenuAdded", "1");
      window.dispatchEvent(new Event("planotto:highlight-shopping"));
    }
  };

  const handleQuickRecipeChooseAnotherDay = () => {
    if (!quickRecipeConfirm) return;

    const targetCellKey = quickRecipeConfirm.cellKey;
    const recipeId = quickRecipeConfirm.recipeId;
    const hasRecipeInLibrary = hasRecipeAvailable(recipeId);

    setQuickRecipeConfirm(null);

    setAddingItemCell(targetCellKey);
    setEditingItem(null);
    setNewItemType(hasRecipeInLibrary ? "recipe" : "text");
    setNewItemText(hasRecipeInLibrary ? "" : quickRecipeConfirm.recipeTitle);
    setNewItemRecipeId(hasRecipeInLibrary ? recipeId : "");
    setNewItemIncludeInShopping(true);
    setNewItemIngredients([{ id: crypto.randomUUID(), name: "", amount: 0, unitId: DEFAULT_UNIT_ID, unit: DEFAULT_UNIT }]);

    const count = getEffectivePeopleCount(targetCellKey);
    setNewItemPeopleCount(count);
    setPeopleInput(count.toString());
    setRecipeCategoryFilter(RECIPE_CATEGORY_FILTER_ALL);
  };

  const handleAddItemConfirm = () => {
    if (!addingItemCell) return;

    const parsed = parseInt(peopleInput) || 1;
    const clamped = Math.max(1, parsed);
    setNewItemPeopleCount(clamped);
    setPeopleInput(clamped.toString());

    updateCellPeopleCount(addingItemCell, clamped);

    const selectedRecipe =
      newItemType === "recipe"
        ? recipes.find((recipe) => recipe.id === newItemRecipeId) || getRecipeFromLocalStorageById(newItemRecipeId)
        : null;
    const baseServings = selectedRecipe?.servings && selectedRecipe.servings > 0 ? selectedRecipe.servings : 2;
    const scale = clamped / baseServings;
    const scaledRecipeIngredients =
      selectedRecipe?.ingredients
        ?.filter(
          (ingredient) =>
            ingredient.name.trim() &&
            (isTasteLikeUnit(ingredient.unitId || ingredient.unit_id || ingredient.unit) || ingredient.amount > 0)
        )
        .map((ingredient) => ({
          ...ingredient,
          amount: isTasteLikeUnit(ingredient.unitId || ingredient.unit_id || ingredient.unit)
            ? 0
            : ingredient.amount * scale,
        })) || [];

    const newItem: MenuItem =
      newItemType === "recipe"
        ? {
            type: "recipe",
            recipeId: newItemRecipeId,
            value: selectedRecipe?.title || undefined,
            ingredients: scaledRecipeIngredients,
            cooked: false,
            id: crypto.randomUUID(),
          }
        : {
            type: "text",
            value: newItemText.trim(),
            includeInShopping: newItemIncludeInShopping,
            ingredients: newItemIncludeInShopping
              ? newItemIngredients.filter(
                  (ing) => ing.name.trim() && (isTasteLikeUnit(ing.unitId || ing.unit_id || ing.unit) || ing.amount > 0)
                )
              : [],
            cooked: false,
            id: crypto.randomUUID(),
          };

    if (newItemType === "recipe" && !newItemRecipeId) return;
    if (newItemType === "text" && !newItemText.trim()) return;

    if (editingItem) {
      setMealData((prev) => ({
        ...prev,
        [addingItemCell]: prev[addingItemCell]?.map((item, idx) => (idx === editingItem.index ? newItem : item)) || [
          newItem,
        ],
      }));
    } else {
      setMealData((prev) => ({
        ...prev,
        [addingItemCell]: [...(prev[addingItemCell] || []), newItem],
      }));
    }

    closeAddEditDialog();
  };

  const handleRemoveItem = (cellKey: string, itemIndex: number) => {
    setMealData((prev) => {
      const currentItems = prev[cellKey] || [];
      const newItems = currentItems.filter((_, idx) => idx !== itemIndex);

      if (newItems.length === 0) {
        const newData = { ...prev };
        delete newData[cellKey];
        return newData;
      }

      return { ...prev, [cellKey]: newItems };
    });
  };

  const handleUndoDeleteItem = () => {
    if (!deletedMenuItem) return;
    const { cellKey, index, item } = deletedMenuItem;
    setMealData((prev) => {
      const currentItems = prev[cellKey] || [];
      const safeIndex = Math.max(0, Math.min(index, currentItems.length));
      const nextItems = [
        ...currentItems.slice(0, safeIndex),
        item,
        ...currentItems.slice(safeIndex),
      ];
      return { ...prev, [cellKey]: nextItems };
    });
    setDeletedMenuItem(null);
  };

  const handleDeleteItem = (cellKey: string, itemIndex: number) => {
    const removedItem = (mealData[cellKey] || [])[itemIndex];
    if (!removedItem) {
      closeDropdownMenu();
      return;
    }
    handleRemoveItem(cellKey, itemIndex);
    setDeletedMenuItem({
      cellKey,
      index: itemIndex,
      item: removedItem,
    });
    closeDropdownMenu();
  };

  const handleEditItem = (cellKey: string, itemIndex: number) => {
    const item = mealData[cellKey]?.[itemIndex];
    if (!item) return;

    closeDropdownMenu();

    setEditingItem({ cellKey, index: itemIndex });
    setAddingItemCell(cellKey);

    if (item.type === "recipe") {
      setNewItemType("recipe");
      setNewItemRecipeId(item.recipeId || "");
      setNewItemText("");
      setNewItemIncludeInShopping(item.includeInShopping ?? true);
      setNewItemIngredients(item.ingredients || [{ id: crypto.randomUUID(), name: "", amount: 0, unitId: DEFAULT_UNIT_ID, unit: DEFAULT_UNIT }]);
    } else {
      setNewItemType("text");
      setNewItemText(item.value || "");
      setNewItemRecipeId("");
      setNewItemIncludeInShopping(item.includeInShopping ?? true);
      setNewItemIngredients(item.ingredients || [{ id: crypto.randomUUID(), name: "", amount: 0, unitId: DEFAULT_UNIT_ID, unit: DEFAULT_UNIT }]);
    }

    const count = getEffectivePeopleCount(cellKey);
    setNewItemPeopleCount(count);
    setPeopleInput(count.toString());
    setRecipeCategoryFilter(RECIPE_CATEGORY_FILTER_ALL);
  };

  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string | number) => {
    setNewItemIngredients((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const addIngredientField = () => {
    setNewItemIngredients((prev) => [...prev, { id: crypto.randomUUID(), name: "", amount: 0, unitId: DEFAULT_UNIT_ID, unit: DEFAULT_UNIT }]);
  };

  const removeIngredientField = (index: number) => {
    setNewItemIngredients((prev) => prev.filter((_, i) => i !== index));
  };

  const handleMoreMenuToggle = (e: React.MouseEvent, menuKey: string, cellKey: string, index: number) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (openMoreMenu === menuKey) {
      closeDropdownMenu();
    } else {
      setOpenMoreMenu(menuKey);
      setMenuAnchor({ cellKey, index, rect });
    }
  };

  const handleMoveClick = (cellKey: string, itemIndex: number) => {
    closeDropdownMenu();
    setMovingItem({ cellKey, index: itemIndex });
    setMoveTargetDay("");
    setMoveTargetMeal("");
  };

  const handleMoveConfirm = () => {
    if (!movingItem || !moveTargetDay) return;

    const fromKey = movingItem.cellKey;
    const fromIndex = movingItem.index;
    const resolvedMeal = dayStructureMode === "list" ? getListAppendMeal(moveTargetDay) : moveTargetMeal;
    if (!resolvedMeal) return;
    const toKey = getCellKey(moveTargetDay, resolvedMeal);

    setMealData((prev) => {
      const newData = { ...prev };
      const fromItems = prev[fromKey] || [];
      const toItems = prev[toKey] || [];
      const itemToMove = fromItems[fromIndex];
      if (!itemToMove) return prev;

      const newFromItems = fromItems.filter((_, idx) => idx !== fromIndex);
      const newToItems = [...toItems, itemToMove];

      if (newFromItems.length === 0) delete newData[fromKey];
      else newData[fromKey] = newFromItems;

      newData[toKey] = newToItems;
      return newData;
    });

    closeMoveDialog();
  };

  const clearWeek = async () => {
    const confirmed = await confirm({
      message: t("menu.confirm.clearCurrentMenu"),
      tone: "danger",
    });
    if (!confirmed) return;

    setMealData({});
    setCellPeopleCount({});
    setCookedStatus({});
    if (activeMenuId) {
      persistMenuSnapshot({}, {}, {}, activeMenuId);
    }
  };

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      dialogMouseDownRef.current = Boolean(target && target.closest(".menu-dialog"));
    };

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;

      // На случай перехода Next.js
      if (target.closest("a") || target.closest('[role="link"]')) {
        dialogMouseDownRef.current = false;
        return;
      }

      const clickedInside =
        target.closest(".menu-grid__item-menu-portal") ||
        target.closest(".menu-grid__item-more") ||
        target.closest(".menu-dialog") ||
        target.closest(".move-dialog");

      if (dialogMouseDownRef.current && !clickedInside) {
        dialogMouseDownRef.current = false;
        return;
      }

      dialogMouseDownRef.current = false;

      if (clickedInside) return;

      if (openMoreMenu) closeDropdownMenu();
      if (movingItem) closeMoveDialog();
      if (addingItemCell) closeAddEditDialog();
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      resetAllModalStates();
    };

    if (openMoreMenu || movingItem || addingItemCell) {
      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("click", handleOutsideClick, false);
      document.addEventListener("keydown", handleEscapeKey, true);
    }

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", handleOutsideClick, false);
      document.removeEventListener("keydown", handleEscapeKey, true);
    };
  }, [openMoreMenu, movingItem, addingItemCell]);

  useEffect(() => {
    return () => {
      resetAllModalStates();
    };
  }, []);

  const DropdownMenu = () => {
    if (!menuAnchor) return null;

    const { cellKey, index, rect } = menuAnchor;
    const dropdownWidth = 150;

    let left = rect.right - dropdownWidth;
    let top = rect.bottom + 6;

    if (left < 0) left = rect.left;
    if (top + 200 > window.innerHeight) top = rect.top - 200 - 6;

    return createPortal(
      <div
        className="menu-grid__item-menu-portal"
        style={{
          position: "fixed",
          left: `${left}px`,
          top: `${top}px`,
          zIndex: 9999,
          background: "white",
          border: "1px solid #ddd",
          borderRadius: "4px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          minWidth: `${dropdownWidth}px`,
        }}
      >
        <button type="button" onClick={() => handleEditItem(cellKey, index)} className="menu-grid__item-menu-edit">
          {t("menu.actions.edit")}
        </button>
        <button type="button" onClick={() => handleMoveClick(cellKey, index)} className="menu-grid__item-menu-move">
          {t("menu.actions.move")}
        </button>
        <button type="button" onClick={() => handleDeleteItem(cellKey, index)} className="menu-grid__item-menu-delete">
          {t("menu.actions.delete")}
        </button>
      </div>,
      document.body
    );
  };

  const MoveDialog = () => {
    if (!movingItem) return null;

    const { cellKey, index } = movingItem;
    const item = mealData[cellKey]?.[index];

    return createPortal(
      <div
        className="move-dialog-overlay"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 10000,
          background: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeMoveDialog();
        }}
      >
        <div
          className="move-dialog"
          style={{
            background: "white",
            border: "1px solid #ddd",
            borderRadius: "8px",
            padding: "20px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
            minWidth: "300px",
            zIndex: 10001,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <h3>{t("menu.moveDialog.title")}</h3>

          <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>
            {t("menu.moveDialog.selectedItem")}{" "}
            <strong>
              {item?.type === "recipe" && item.recipeId
                ? recipes.find((r) => r.id === item.recipeId)?.title || ""
                : item?.value || ""}
            </strong>
          </div>

          <div className="move-dialog-row">
            <label>{t("menu.moveDialog.dayLabel")}</label>
            <select
              value={moveTargetDay}
              onChange={(e) => {
                const nextDay = e.target.value;
                setMoveTargetDay(nextDay);
                if (dayStructureMode === "list") {
                  setMoveTargetMeal(nextDay ? getListAppendMeal(nextDay) : "");
                }
              }}
              className="move-dialog-select"
            >
              <option value="">{t("menu.moveDialog.choose")}</option>
              {visibleDayEntries.map((dayEntry) => (
                <option key={dayEntry.dateKey} value={dayEntry.dateKey}>
                  {dayEntry.dayLabel} {dayEntry.displayDate}
                </option>
              ))}
            </select>
          </div>

          {dayStructureMode === "meals" ? (
            <div className="move-dialog-row">
              <label>{t("menu.moveDialog.mealLabel")}</label>
              <select value={moveTargetMeal} onChange={(e) => setMoveTargetMeal(e.target.value)} className="move-dialog-select">
                <option value="">{t("menu.moveDialog.choose")}</option>
                {(moveTargetDay ? getDayMeals(moveTargetDay) : [...defaultDayMeals]).map((meal) => (
                  <option key={meal} value={meal}>
                    {meal}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="move-dialog-actions">
            <button
              type="button"
              onClick={handleMoveConfirm}
              disabled={!moveTargetDay || (dayStructureMode === "meals" && !moveTargetMeal)}
              className="move-dialog-confirm"
            >
              {t("menu.actions.move")}
            </button>
            <button type="button" onClick={closeMoveDialog} className="move-dialog-cancel">
              {t("menu.actions.cancel")}
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  };

  const activeProductsDialog = showActiveProductsDialog
    ? createPortal(
      <div
        className="move-dialog-overlay"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 10000,
          background: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "12px",
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeActiveProductsDialog();
        }}
      >
        <div
          style={{
            background: "white",
            border: "1px solid #ddd",
            borderRadius: "12px",
            padding: "14px",
            width: "min(760px, 96vw)",
            maxHeight: "88vh",
            overflow: "auto",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
            <h3 style={{ margin: 0 }}>{t("menu.activeProducts.allTitle")}</h3>
            <button type="button" className="btn" onClick={closeActiveProductsDialog}>
              {t("menu.actions.close")}
            </button>
          </div>

          <p className="muted" style={{ margin: "8px 0 0 0", fontSize: "13px" }}>
            {t("menu.activeProducts.count", { count: visibleActiveProductsCount })}
          </p>

          <div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 280px", minWidth: "220px" }}>
              <ProductAutocompleteInput
                value={activeProductName}
                onChange={setActiveProductName}
                suggestions={activeProductAutocompleteSuggestions}
                placeholder={t("menu.activeProducts.addPlaceholder")}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={addActiveProduct}
              disabled={activeProductName.trim().length === 0}
            >
              {t("menu.actions.add")}
            </button>
          </div>

          {shouldShowActiveProductsSearch ? (
            <div style={{ marginTop: "10px" }}>
              <input
                className="input"
                type="text"
                placeholder={t("menu.activeProducts.searchPlaceholder")}
                value={activeProductsSearch}
                onChange={(e) => setActiveProductsSearch(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
          ) : null}

          <div style={{ marginTop: "12px", display: "grid", gap: "8px" }}>
            {filteredActiveProducts.length > 0 ? (
              filteredActiveProducts.map((product) => {
                const isExpanded = expandedActiveProductNoteId === product.id;
                const scopeLabel = getActiveProductScopeLabel(product);
                const trimmedNote = (product.note || "").trim();
                const notePreview = trimmedNote.length > 40 ? `${trimmedNote.slice(0, 40)}...` : trimmedNote;
                const actionIconButtonStyle: React.CSSProperties = {
                  width: "28px",
                  height: "28px",
                  border: "1px solid var(--border-default)",
                  borderRadius: "8px",
                  background: "var(--background-primary)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  padding: 0,
                  color: "var(--text-secondary)",
                };

                return (
                  <div
                    key={product.id}
                    style={{
                      border: "1px solid var(--border-default)",
                      borderRadius: "10px",
                      padding: "8px",
                      background: "var(--background-primary)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedActiveProductNoteId((prev) => (prev === product.id ? null : product.id))}
                        style={{
                          flex: "1 1 auto",
                          minWidth: 0,
                          border: "none",
                          background: "transparent",
                          padding: 0,
                          textAlign: "left",
                          cursor: "pointer",
                          color: "inherit",
                        }}
                      >
                        <span style={{ display: "grid", gap: "2px" }}>
                          <span style={{ display: "inline-flex", gap: "6px", alignItems: "baseline", flexWrap: "wrap" }}>
                            <strong>{product.name}</strong>
                            <span style={{ color: "var(--text-secondary)", fontSize: "13px" }}>{scopeLabel}</span>
                          </span>
                          {notePreview || activeProductSavedNoteId === product.id ? (
                            <span style={{ display: "inline-flex", gap: "6px", alignItems: "center", minHeight: "16px" }}>
                              {notePreview ? (
                                <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>{notePreview}</span>
                              ) : null}
                              {activeProductSavedNoteId === product.id ? (
                                <span style={{ color: "var(--accent-primary)", whiteSpace: "nowrap", fontSize: "11px" }}>
                                  {t("menu.activeProducts.saved")}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setExpandedActiveProductNoteId(product.id)}
                        style={actionIconButtonStyle}
                        title={t("menu.actions.edit")}
                        aria-label={t("menu.actions.edit")}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                          <path d="M14.06 6.19l3.75 3.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeActiveProduct(product.id)}
                        style={actionIconButtonStyle}
                        title={t("menu.actions.delete")}
                        aria-label={t("menu.actions.delete")}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M4 7h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          <path d="M9 7V5h6v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          <path d="M7 7l1 12h8l1-12" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>

                    {isExpanded ? (
                      <div
                        style={{
                          marginTop: "8px",
                          display: "grid",
                          gap: "6px",
                          border: "1px solid var(--border-default)",
                          borderRadius: "10px",
                          padding: "8px",
                          background: "var(--background-primary)",
                        }}
                      >
                        <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("menu.activeProducts.scopeLabel")}</label>
                        <select
                          className="input"
                          value={product.scope}
                          onChange={(e) => updateActiveProductScope(product.id, e.target.value as ActiveProductScope)}
                        >
                          <option value="in_period">{t("menu.activeProducts.scopeInMenuOption")}</option>
                          <option value="persistent">{t("menu.activeProducts.scopePersistentOption")}</option>
                          <option value="until_date">{t("menu.activeProducts.scopeUntilDateOption")}</option>
                        </select>
                        {product.scope === "until_date" ? (
                          <>
                            <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("menu.activeProducts.dateLabel")}</label>
                            <input
                              className="input"
                              type="date"
                              value={product.untilDate}
                              onChange={(e) => updateActiveProductUntilDate(product.id, e.target.value)}
                            />
                          </>
                        ) : null}
                        <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                          {t("menu.activeProducts.noteLabel", { max: ACTIVE_PRODUCT_NOTE_MAX_LENGTH })}
                        </label>
                        <input
                          className="input"
                          type="text"
                          placeholder={t("menu.activeProducts.notePlaceholder")}
                          maxLength={ACTIVE_PRODUCT_NOTE_MAX_LENGTH}
                          value={getActiveProductNoteValue(product)}
                          onChange={(e) => handleActiveProductNoteDraftChange(product.id, e.target.value)}
                          onBlur={() => handleActiveProductNoteBlur(product.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                        />
                        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "12px" }}>
                          <input
                            type="checkbox"
                            checked={product.prefer}
                            onChange={() => toggleActiveProductPriority(product.id)}
                          />
                          {t("menu.activeProducts.priority")}
                        </label>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setExpandedActiveProductNoteId(null)}
                            style={{ padding: "2px 8px" }}
                          >
                            {t("menu.actions.save")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {t("menu.activeProducts.notFound")}
              </p>
            )}
          </div>
        </div>
      </div>,
      document.body
    )
    : null;

  const renderMenuItemRow = (
    cellKey: string,
    menuItem: MenuItem,
    index: number,
    dayKey: string
  ) => {
    const menuKey = `${cellKey}-${index}`;
    const title =
      menuItem.type === "recipe" && menuItem.recipeId
        ? recipes.find((r) => r.id === menuItem.recipeId)?.title || ""
        : menuItem.value || "";
    const hasIngredients = getMenuItemIngredients(cellKey, menuItem).length > 0;

    return (
      <div key={menuItem.id} className="menu-slot-item">
        <span className="menu-slot-item__title" title={title}>
          {title}
        </span>

        <div className="menu-slot-item__icons">
          <label className="menu-slot-item__icon-toggle" title={t("menu.item.cooked")}>
            <input
              type="checkbox"
              checked={getDefaultCookedStatus(dayKey, menuItem.id)}
              onChange={(e) => {
                if (e.target.checked) {
                  markMenuItemCooked(cellKey, index, true);
                } else {
                  const updatedItems = [...(mealData[cellKey] || [])];
                  updatedItems[index] = { ...updatedItems[index], cooked: false };

                  setMealData((prev) => ({ ...prev, [cellKey]: updatedItems }));
                  setCookedStatus((prev) => ({ ...prev, [menuItem.id]: false }));
                }
              }}
              className="menu-slot-item__checkbox"
            />
          </label>

          {menuItem.type === "text" ? (
            <span className="menu-slot-item__icon" title={t("menu.item.noRecipe")}>
              T
            </span>
          ) : null}

          {hasIngredients ? (
            <span className="menu-slot-item__icon" title={t("menu.item.hasIngredients")}>
              I
            </span>
          ) : null}

          <button
            className="menu-grid__item-more menu-slot-item__more"
            onClick={(e) => handleMoreMenuToggle(e, menuKey, cellKey, index)}
            title={t("menu.actions.actions")}
          >
            ...
          </button>
        </div>
      </div>
    );
  };

  const exportCurrentMenuPdf = async () => {
    if (!canUsePdfExport) {
      setMenuSyncError(t("subscription.locks.pdfExportShort"));
      return;
    }

    const activeMenuName =
      getMenuDisplayName(menuProfiles.find((menu) => menu.id === activeMenuId)?.name || "") ||
      defaultMenuName ||
      t("menu.fallback.defaultMenuName");

    const days = visibleDayEntries.map((dayEntry) => {
      const meals = getDayMeals(dayEntry.dateKey).map((meal) => {
        const cellKey = getCellKey(dayEntry.dateKey, meal);
        const dishes = (mealData[cellKey] || [])
          .map((item) => getMenuItemTitleForExport(item))
          .filter(Boolean);
        return { mealName: meal, dishes };
      });
      return {
        dayLabel: dayEntry.dayLabel,
        dateLabel: dayEntry.displayDate,
        meals,
      };
    });

    try {
      setMenuSyncError("");
      setIsExportingMenuPdf(true);
      await downloadPdfExport({
        kind: "menu",
        menuTitle: activeMenuName,
        periodLabel: getRangeDisplay(weekStart, periodEnd, locale),
        days,
        fileName: `planotto-menu-${weekStart}-${periodEnd}.pdf`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("menu.actions.exportFailed");
      setMenuSyncError(message);
    } finally {
      setIsExportingMenuPdf(false);
    }
  };

  const exportMenuWithRecipesPdf = async () => {
    if (!canUsePdfExport) {
      setMenuSyncError(t("subscription.locks.pdfExportShort"));
      return;
    }

    const activeMenuName =
      getMenuDisplayName(menuProfiles.find((menu) => menu.id === activeMenuId)?.name || "") ||
      defaultMenuName ||
      t("menu.fallback.defaultMenuName");

    const days = visibleDayEntries.map((dayEntry) => {
      const meals = getDayMeals(dayEntry.dateKey).map((meal) => {
        const cellKey = getCellKey(dayEntry.dateKey, meal);
        const dishes = (mealData[cellKey] || [])
          .map((item) => getMenuItemTitleForExport(item))
          .filter(Boolean);
        return { mealName: meal, dishes };
      });
      return {
        dayLabel: dayEntry.dayLabel,
        dateLabel: dayEntry.displayDate,
        meals,
      };
    });

    const recipesUsageMap = new Map<string, { recipe: Recipe; usedIn: Set<string> }>();
    visibleDayEntries.forEach((dayEntry) => {
      const dayKeyLabel = `${dayEntry.dayLabel} ${dayEntry.displayDate}`.trim();
      getDayMeals(dayEntry.dateKey).forEach((meal) => {
        const cellKey = getCellKey(dayEntry.dateKey, meal);
        (mealData[cellKey] || []).forEach((item) => {
          if (item.type !== "recipe" || !item.recipeId) return;
          const recipe = getRecipeForPdfExport(item.recipeId);
          if (!recipe) return;

          if (!recipesUsageMap.has(recipe.id)) {
            recipesUsageMap.set(recipe.id, { recipe, usedIn: new Set<string>() });
          }
          recipesUsageMap.get(recipe.id)?.usedIn.add(dayKeyLabel);
        });
      });
    });

    const recipePayloads: PdfRecipePayload[] = Array.from(recipesUsageMap.values())
      .map(({ recipe, usedIn }) => {
        const instructions = String(recipe.instructions || recipe.description || "").trim();
        const steps = instructions
          .split(/\n+/g)
          .map((line) => line.trim())
          .filter(Boolean);
        return {
          title: String(recipe.title || t("menu.fallback.recipeTitle")).trim(),
          servings: recipe.servings || 2,
          cookingTime: findCookingTimeLabel(recipe),
          ingredients: (recipe.ingredients || []).map(formatIngredientForPdf).filter(Boolean),
          steps: steps.length > 0 ? steps : [t("pdf.fallback.noSteps")],
          usedIn: Array.from(usedIn.values()),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, activeLocale));

    try {
      setMenuSyncError("");
      setIsExportingMenuWithRecipesPdf(true);
      await downloadPdfExport({
        kind: "menu_full",
        menuTitle: activeMenuName,
        periodLabel: getRangeDisplay(weekStart, periodEnd, locale),
        days,
        recipes: recipePayloads,
        fileName: `planotto-menu-full-${weekStart}-${periodEnd}.pdf`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("menu.actions.exportFailed");
      setMenuSyncError(message);
    } finally {
      setIsExportingMenuWithRecipesPdf(false);
    }
  };

  const handleDownloadPdfFromDialog = async () => {
    if (!canUsePdfExport) {
      setMenuSyncError(t("subscription.locks.pdfExportShort"));
      return;
    }

    setShowPdfExportDialog(false);
    if (pdfExportMode === "menu_full") {
      await exportMenuWithRecipesPdf();
      return;
    }
    await exportCurrentMenuPdf();
  };

  const pendingDeleteMenu = pendingDeleteMenuId
    ? menuProfiles.find((menu) => menu.id === pendingDeleteMenuId) || null
    : null;

  return (
    <>
      {showFirstVisitOnboarding && (
        <div className="menu-first-onboarding" role="dialog" aria-modal="true" aria-label={t("menu.onboarding.firstVisitAria")}>
          <div className="menu-first-onboarding__card">
            <img
              src="/mascot/pages/menu-onboarding.png"
              alt=""
              aria-hidden="true"
              className="menu-first-onboarding__mascot"
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = "/mascot/pages/menu.png";
              }}
            />
            <h2 className="menu-first-onboarding__title">{t("menu.onboarding.title")}</h2>
            <p className="menu-first-onboarding__text">
              {t("menu.onboarding.description")}
            </p>
            <div className="menu-first-onboarding__actions">
              <button type="button" className="btn btn-primary" onClick={handleOnboardingAddFirstRecipe}>
                {t("menu.onboarding.addFirstRecipe")}
              </button>
              <button type="button" className="menu-first-onboarding__skip" onClick={handleOnboardingTryWithoutRecipes}>
                {t("menu.onboarding.tryWithout")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showMenuAddedNotice && (
        <div
          className="card"
          style={{
            maxWidth: "760px",
            margin: "0 auto 12px auto",
            padding: "12px 14px",
            borderRadius: "10px",
          }}
        >
          <p style={{ margin: "0", fontWeight: 700 }}>{t("menu.notice.dishAdded")}</p>
          <p className="muted" style={{ margin: "4px 0 10px 0" }}>
            {menuAddedHasIngredients
              ? t("menu.notice.ingredientsAdded")
              : t("menu.notice.noIngredientsYet")}
          </p>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.sessionStorage.setItem(GUEST_REMINDER_PENDING_KEY, "1");
                }
                generateShoppingList();
              }}
            >
              {t("menu.notice.openShopping")}
            </button>
            <button
              type="button"
              className="menu-first-onboarding__skip"
              style={{ fontSize: "12px" }}
              onClick={() => {
                setShowMenuAddedNotice(false);
                setMenuAddedHasIngredients(false);
                if (typeof window !== "undefined") {
                  window.sessionStorage.setItem(GUEST_REMINDER_PENDING_KEY, "1");
                }
              }}
            >
              {t("menu.notice.continuePlanning")}
            </button>
          </div>
        </div>
      )}

      {deletedMenuItem && (
        <div className="recipes-add-to-menu-banner" role="status" aria-live="polite">
          <span className="recipes-add-to-menu-banner__text">{t("menu.notice.dishDeleted")}</span>
          <div className="recipes-add-to-menu-banner__actions">
            <button type="button" className="btn" onClick={handleUndoDeleteItem}>
              {t("menu.notice.undoDelete")}
            </button>
          </div>
        </div>
      )}


      {showGuestReminder && !showMenuAddedNotice && (
        <div
          className="card"
          style={{
            maxWidth: "760px",
            margin: "0 auto 12px auto",
            padding: "12px 14px",
            borderRadius: "10px",
          }}
        >
          <img
            src="/mascot/pages/auth.png"
            alt=""
            aria-hidden="true"
            style={{ width: "74px", height: "74px", objectFit: "contain", marginBottom: "6px" }}
          />
          <p style={{ margin: 0, fontWeight: 700 }}>
            {guestReminderStrong
              ? t("menu.guestReminder.strong")
              : t("menu.guestReminder.normal")}
          </p>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px", marginTop: "8px" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setShowGuestReminder(false);
                router.push("/auth");
              }}
            >
              {t("menu.guestReminder.createAccount")}
            </button>
            <button
              type="button"
              className="menu-first-onboarding__skip"
              style={{ fontSize: "12px" }}
              onClick={() => setShowGuestReminder(false)}
            >
              {t("menu.guestReminder.later")}
            </button>
          </div>
        </div>
      )}

      {quickRecipeConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("menu.quickAdd.confirmAria")}
          className="menu-first-onboarding"
        >
          <div className="menu-first-onboarding__card" style={{ width: "min(560px, 100%)", paddingTop: "26px" }}>
            <img
              src="/mascot/pages/menu.png"
              alt=""
              aria-hidden="true"
              className="menu-first-onboarding__mascot"
            />
            <h3 style={{ margin: "0 0 8px 0", color: "#333", fontSize: "28px" }}>
              {t("menu.quickAdd.confirmText", {
                recipe: quickRecipeConfirm.recipeTitle,
                day: quickRecipeConfirm.dayLabel,
                meal: quickRecipeConfirm.mealLabel,
              })}
            </h3>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button type="button" className="btn btn-primary" onClick={handleQuickRecipeAdd}>
                {t("menu.actions.add")}
              </button>
              <button type="button" className="btn" onClick={handleQuickRecipeChooseAnotherDay}>
                {t("menu.quickAdd.chooseAnotherDay")}
              </button>
            </div>
          </div>
        </div>
      )}
      <section className="card">
      <div className="menu-header">
        <h1 className="h1">{t("menu.title")}</h1>
        <div className="week-navigation week-navigation--compact">
          <button
            className="week-nav-btn week-nav-btn--icon"
            onClick={goToPreviousWeek}
            aria-label={t("menu.period.previousAria")}
            title={t("menu.period.previousAria")}
          >
            ‹
          </button>
          <div className="week-range-compact">
            <span className="week-range">{getRangeDisplay(weekStart, periodEnd, locale)}</span>
            <span className="week-range-meta">{t("menu.period.daysCount", { count: periodDays })}</span>
          </div>
          <button
            className="week-nav-btn week-nav-btn--icon"
            onClick={goToNextWeek}
            aria-label={t("menu.period.nextAria")}
            title={t("menu.period.nextAria")}
          >
            ›
          </button>
        </div>
      </div>

      {profileGoal === "menu" ? (
        <p className="muted" style={{ marginTop: "0", marginBottom: "10px" }}>
          {t("menu.goalHints.planning")}
        </p>
      ) : null}

      <div className="card" style={{ marginBottom: "10px", padding: "8px 10px" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <div className="menu-toolbar-main">
            <div className="menu-toolbar-selector">
              <strong style={{ fontSize: "15px" }}>{t("menu.selector.label")}</strong>
              <select
                className="input menu-toolbar-selector__input"
                value={activeMenuId}
                onChange={(e) => handleSelectMenuProfile(e.target.value)}
                title={t("menu.selector.aria")}
                aria-label={t("menu.selector.aria")}
              >
                {menuProfiles.map((menu) => (
                  <option key={menu.id} value={menu.id}>
                    {getMenuDisplayName(menu.name)}
                  </option>
                ))}
              </select>
            </div>
            <div className="menu-toolbar-actions">
              <button
                type="button"
                className="btn"
                style={{ whiteSpace: "nowrap", padding: "6px 10px" }}
                onClick={() => setIsCreateMenuDialogOpen(true)}
                title={additionalMenusLocked ? t("subscription.locks.multipleMenus") : undefined}
              >
                {t("menu.templates.newMenu")}
              </button>
              <button
                type="button"
                className="btn"
                style={{ whiteSpace: "nowrap", padding: "6px 10px" }}
                onClick={() => setShowMenuTemplatesPanel((prev) => !prev)}
              >
                {t("menu.templates.button")}
              </button>
              <button
                type="button"
                className="btn"
                style={{ minWidth: "36px", padding: "6px 10px" }}
                title={t("menu.settings.title")}
                aria-label={t("menu.settings.title")}
                onClick={() => setShowMenuSettingsDialog(true)}
              >
                ⚙
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: "12px" }}>
              {t("menu.mode.label")}
            </span>
            <div
              role="group"
              aria-label={t("menu.mode.aria")}
              style={{
                display: "inline-flex",
                border: "1px solid var(--border-default)",
                borderRadius: "999px",
                padding: "2px",
                background: "var(--background-primary)",
              }}
            >
              <button
                type="button"
                className={dayStructureMode === "list" ? "btn btn-primary" : "btn"}
                style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
                onClick={() => setDayStructureMode("list")}
              >
                {t("menu.mode.list")}
              </button>
              <button
                type="button"
                className={dayStructureMode === "meals" ? "btn btn-primary" : "btn"}
                style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
                onClick={() => setDayStructureMode("meals")}
              >
                {t("menu.mode.meals")}
              </button>
            </div>
          </div>
          {isActiveMenuEmpty && (
            <div className="menu-empty-actions">
              <span className="muted">{t("menu.templates.emptyPrompt")}</span>
              <div className="menu-empty-actions__buttons">
                <button type="button" className="btn" onClick={() => setIsCreateMenuDialogOpen(true)}>
                  {t("menu.templates.createMenu")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setShowMenuTemplatesPanel(true)}
                >
                  {t("menu.templates.loadExample")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {shouldShowMenuTemplatesPanel && (
        <div className="card menu-templates-panel">
          <div className="menu-templates-panel__header">
            <div>
              <h2 className="menu-templates-panel__title">{t("menu.templates.startWithExample")}</h2>
              <p className="menu-templates-panel__description">{t("menu.templates.panelDescription")}</p>
            </div>
            {!allMenusEmpty && (
              <button
                type="button"
                className="menu-first-onboarding__skip"
                onClick={() => setShowMenuTemplatesPanel(false)}
              >
                {t("menu.actions.close")}
              </button>
            )}
          </div>
          <div className="menu-templates-grid">
            {demoMenuTemplates.map((template) => (
              <article key={template.id} className="menu-template-card">
                <h3 className="menu-template-card__title">{template.title}</h3>
                <p className="menu-template-card__description">{template.description}</p>
                <button type="button" className="btn btn-primary" onClick={() => applyDemoMenuTemplate(template.id)}>
                  {t("menu.templates.addToMine")}
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {showCalendarInlineHint && recipes.length === 0 && (
        <div className="menu-inline-onboarding-hint">
          {t("menu.inlineHint.textBefore")} <strong>+</strong> {t("menu.inlineHint.textAfter")}
          <button type="button" className="menu-inline-onboarding-hint__close" onClick={dismissCalendarInlineHint}>
            {t("menu.inlineHint.ok")}
          </button>
        </div>
      )}

      <div className="menu-board">
        {visibleDayEntries.map((dayEntry) => {
          const dayMeals = getDayMeals(dayEntry.dateKey);
          const allDayMeals = getAllMealsForDay(dayEntry.dateKey);
          const dayListEntries = getDayListEntries(dayEntry.dateKey);
          const listAddCellKey = getCellKey(dayEntry.dateKey, getListAppendMeal(dayEntry.dateKey));
          const dayTargetCount = Math.max(1, allDayMeals.length);
          const dayFilledCount = dayListEntries.length;
          const dayFillPercent = Math.min(100, Math.round((dayFilledCount / dayTargetCount) * 100));
          return (
            <article key={dayEntry.dateKey} className="menu-day-card">
              <header className="menu-day-card__header">
                <div className="menu-day-card__header-main">
                  <span className="menu-day-card__day">{dayEntry.dayLabel}</span>
                  <span className="menu-day-card__date">{dayEntry.displayDate}</span>
                </div>
                <div className="menu-day-card__progress" aria-label={t("menu.day.fillAria", { percent: dayFillPercent })}>
                  <div className="menu-day-card__progress-track">
                    <div
                      className="menu-day-card__progress-fill"
                      style={{ width: `${dayFillPercent}%` }}
                      aria-hidden="true"
                    />
                  </div>
                  <span className="menu-day-card__progress-label">
                    {dayFilledCount}/{dayTargetCount}
                  </span>
                </div>
              </header>

              {dayStructureMode === "list" ? (
                <div className="menu-day-card__meals">
                  <section className="menu-slot" data-cell-key={listAddCellKey}>
                    <div className="menu-slot__header">
                      <span className="menu-slot__meal">{t("menu.day.dishesOfDay")}</span>
                      <button
                        className="menu-slot__add"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAddItemClick(listAddCellKey);
                        }}
                        title={t("menu.day.addDishToDay")}
                      >
                        +
                      </button>
                    </div>
                    <div className="menu-slot__items">
                      {dayListEntries.length > 0 ? (
                        dayListEntries.map((entry) =>
                          renderMenuItemRow(entry.cellKey, entry.item, entry.index, dayEntry.dateKey)
                        )
                      ) : (
                        <button
                          className="menu-slot__empty"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddItemClick(listAddCellKey);
                          }}
                        >
                          {t("menu.day.addDish")}
                        </button>
                      )}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="menu-day-card__meals">
                  {dayMeals.map((meal) => {
                    const key = getCellKey(dayEntry.dateKey, meal);
                    const items = mealData[key] || [];

                    return (
                      <section key={key} className="menu-slot" data-cell-key={key}>
                        <div className="menu-slot__header">
                          <span className="menu-slot__meal">{meal}</span>
                          <button
                            className="menu-slot__add"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAddItemClick(key);
                            }}
                            title={t("menu.day.addDishWithMeal", { meal })}
                          >
                            +
                          </button>
                        </div>

                        <div className="menu-slot__items">
                          {items.length > 0 ? (
                            items.map((menuItem, index) => renderMenuItemRow(key, menuItem, index, dayEntry.dateKey))
                          ) : (
                            <button
                              className="menu-slot__empty"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAddItemClick(key);
                              }}
                            >
                              {t("menu.day.addDish")}
                            </button>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {menuSyncError ? (
        <p className="muted" style={{ marginTop: "0", marginBottom: "10px" }}>
          {menuSyncError}
        </p>
      ) : null}

      {showMenuSettingsDialog ? (
        <div
          className="menu-dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("menu.settings.title")}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeMenuSettingsDialog();
          }}
        >
          <div
            className="menu-dialog menu-settings-dialog"
            style={{ width: "min(760px, 96vw)", maxHeight: "88vh", overflow: "auto" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <h3 style={{ margin: 0 }}>{t("menu.settings.title")}</h3>
              <button type="button" className="btn" onClick={closeMenuSettingsDialog}>
                {t("menu.actions.close")}
              </button>
            </div>

            <div
              style={{
                marginTop: "10px",
                border: "1px solid var(--border-default)",
                borderRadius: "10px",
                padding: "10px",
                display: "grid",
                gap: "8px",
              }}
            >
              <strong style={{ fontSize: "14px" }}>{t("menu.settings.dayStructure")}</strong>
              <div
                role="group"
                aria-label={t("menu.mode.aria")}
                style={{
                  display: "inline-flex",
                  border: "1px solid var(--border-default)",
                  borderRadius: "999px",
                  padding: "2px",
                  width: "fit-content",
                }}
              >
                <button
                  type="button"
                  className={dayStructureMode === "list" ? "btn btn-primary" : "btn"}
                  style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
                  onClick={() => setDayStructureMode("list")}
                >
                  {t("menu.mode.list")}
                </button>
                <button
                  type="button"
                  className={dayStructureMode === "meals" ? "btn btn-primary" : "btn"}
                  style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
                  onClick={() => setDayStructureMode("meals")}
                >
                  {t("menu.mode.meals")}
                </button>
              </div>
              <div>
                <button type="button" className="btn" onClick={() => setShowMealSettingsDialog(true)}>
                  {t("menu.settings.configureMeals")}
                </button>
              </div>
              <div
                style={{
                  marginTop: "6px",
                  borderTop: "1px solid var(--border-default)",
                  paddingTop: "8px",
                  display: "grid",
                  gap: "8px",
                }}
              >
                <strong style={{ fontSize: "13px" }}>{t("menu.settings.mealsPerDayTitle")}</strong>
                <span className="muted" style={{ fontSize: "13px" }}>
                  {t("menu.settings.mealsPerDayCurrent", {
                    value: t(`auth.options.mealsPerDay.${profileMealsPerDayPreference}`),
                  })}
                </span>
                {profileMealsPerDayPreference === "1-2" ? (
                  <label style={{ display: "grid", gap: "6px", fontSize: "13px" }}>
                    <span>{t("menu.settings.twoMealsChoiceLabel")}</span>
                    <select
                      className="menu-dialog__select"
                      value={twoMealsMode}
                      onChange={(e) => {
                        const nextMode = normalizeTwoMealsMode(e.target.value);
                        setTwoMealsMode(nextMode);
                        applyMealsPerDayPreset("1-2", nextMode);
                      }}
                      style={{ maxWidth: "240px" }}
                    >
                      <option value="breakfast_lunch">{t("menu.settings.twoMealsOptions.breakfastLunch")}</option>
                      <option value="lunch_dinner">{t("menu.settings.twoMealsOptions.lunchDinner")}</option>
                      <option value="breakfast_dinner">{t("menu.settings.twoMealsOptions.breakfastDinner")}</option>
                    </select>
                  </label>
                ) : null}
                <div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => applyMealsPerDayPreset(profileMealsPerDayPreference)}
                  >
                    {t("menu.settings.applyMealsPreset")}
                  </button>
                </div>
              </div>
            </div>

            <div
              style={{
                marginTop: "10px",
                border: "1px solid var(--border-default)",
                borderRadius: "10px",
                padding: "10px",
                display: "grid",
                gap: "8px",
              }}
            >
              <strong style={{ fontSize: "14px" }}>{t("menu.settings.periodTitle")}</strong>
              <label style={{ display: "grid", gap: "6px", fontSize: "14px" }}>
                <span>{t("menu.settings.periodPresetLabel")}</span>
                <select
                  className="menu-dialog__select"
                  value={periodPreset}
                  onChange={(e) => {
                    const nextPreset = e.target.value as PeriodPreset;
                    setPeriodPreset(nextPreset);
                    if (nextPreset !== "custom") {
                      applyPeriodPreset(nextPreset);
                    }
                  }}
                  style={{ maxWidth: "240px" }}
                >
                  <option value="7d">{t("menu.period.presets.7d")}</option>
                  <option value="10d">{t("menu.period.presets.10d")}</option>
                  <option value="14d">{t("menu.period.presets.14d")}</option>
                  <option value="month">{t("menu.period.presets.month")}</option>
                  <option value="custom">{t("menu.period.presets.custom")}</option>
                </select>
              </label>

              {periodPreset === "custom" ? (
                <div style={{ display: "grid", gap: "8px" }}>
                  <label style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
                    <span>{t("menu.period.customStart")}</span>
                    <input
                      type="date"
                      className="input"
                      value={customStartInput}
                      onChange={(e) => setCustomStartInput(e.target.value)}
                      style={{ maxWidth: "240px" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
                    <span>{t("menu.period.customEnd")}</span>
                    <input
                      type="date"
                      className="input"
                      value={customEndInput}
                      onChange={(e) => setCustomEndInput(e.target.value)}
                      style={{ maxWidth: "240px" }}
                    />
                  </label>
                  <div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => applyPeriodPreset("custom")}
                      disabled={!customStartInput || !customEndInput}
                    >
                      {t("menu.period.applyCustom")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div
              style={{
                marginTop: "10px",
                border: "1px solid var(--border-default)",
                borderRadius: "10px",
                padding: "10px",
                display: "grid",
                gap: "8px",
              }}
            >
              <strong style={{ fontSize: "14px" }}>{t("menu.settings.planningDaysTitle")}</strong>
              <span className="muted" style={{ fontSize: "13px" }}>
                {t("menu.settings.planningDaysSelected", { count: planningDayKeys.length, total: dayKeys.length })}
              </span>
              <span style={{ fontSize: "13px" }}>{t("menu.settings.planningDaysPresetLabel")}</span>
              <div
                role="group"
                aria-label={t("menu.settings.planningDaysPresetLabel")}
                style={{
                  display: "inline-flex",
                  border: "1px solid var(--border-default)",
                  borderRadius: "999px",
                  padding: "2px",
                  width: "fit-content",
                }}
              >
                {(["weekdays", "weekends", "all"] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={isPlanningPresetActive(preset) ? "btn btn-primary" : "btn"}
                    style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
                    onClick={() => applyPlanningDaysPreset(preset)}
                  >
                    {t(`auth.options.planDays.${preset}`)}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {dayEntries.map((dayEntry) => {
                  const isSelected = planningDayKeys.includes(dayEntry.dateKey);
                  return (
                    <button
                      key={dayEntry.dateKey}
                      type="button"
                      className={isSelected ? "btn btn-primary" : "btn"}
                      style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
                      onClick={() => togglePlanningDay(dayEntry.dateKey)}
                    >
                      {dayEntry.dayLabel} {dayEntry.displayDate}
                    </button>
                  );
                })}
              </div>
              <span className="muted" style={{ fontSize: "12px" }}>
                {t("menu.settings.planningDaysHelp")}
              </span>
            </div>

            <label style={{ marginTop: "10px", display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                checked={mergeShoppingWithAllMenus}
                onChange={(e) => setMergeShoppingWithAllMenus(e.target.checked)}
              />
              {t("menu.settings.mergeMenusForShopping")}
            </label>

            <label style={{ marginTop: "4px", display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                checked={showAddRecipePromptInRecipes}
                onChange={(e) => setShowAddRecipePromptInRecipes(e.target.checked)}
              />
              {t("menu.settings.showAddRecipePrompt")}
            </label>

            <div
              style={{
                marginTop: "10px",
                border: "1px solid var(--border-default)",
                borderRadius: "10px",
                padding: "10px",
                display: "grid",
                gap: "8px",
              }}
            >
              <strong style={{ fontSize: "14px" }}>{t("menu.settings.activeProducts")}</strong>
              <span className="muted" style={{ fontSize: "13px" }}>
                {t("menu.activeProducts.count", { count: visibleActiveProductsCount })}
              </span>
              <div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    closeMenuSettingsDialog();
                    router.push("/priority-products");
                  }}
                >
                  {t("menu.actions.open")}
                </button>
              </div>
            </div>

            <div
              style={{
                marginTop: "12px",
                paddingTop: "10px",
                borderTop: "1px solid var(--border-default)",
                display: "grid",
                gap: "8px",
              }}
            >
              <strong style={{ fontSize: "14px" }}>{t("menu.settings.manageMenus")}</strong>
              {menuProfiles.map((menu) => (
                <div
                  key={menu.id}
                  style={{
                    display: "grid",
                    gap: "8px",
                    border: "1px solid var(--border-default)",
                    borderRadius: "10px",
                    padding: "8px",
                    background: "var(--background-primary)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <input
                      className="input"
                      style={{ minWidth: "180px", flex: "1 1 220px" }}
                      value={nameDrafts[menu.id] || ""}
                      aria-label={t("menu.settings.menuNameAria", { name: getMenuDisplayName(menu.name) })}
                      onChange={(e) =>
                        setNameDrafts((prev) => ({
                          ...prev,
                          [menu.id]: e.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "6px 10px", fontSize: "13px" }}
                      onClick={() => saveMenuName(menu.id)}
                    >
                      {t("menu.actions.save")}
                    </button>
                    {menu.id === activeMenuId ? (
                      <span className="muted" style={{ fontSize: "12px" }}>
                        {t("menu.settings.currentMenu")}
                      </span>
                    ) : null}
                  </div>

                  <div
                    style={{
                      borderTop: "1px solid var(--border-default)",
                      paddingTop: "8px",
                      display: "flex",
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "5px 10px", fontSize: "13px", color: "var(--text-secondary)" }}
                      onClick={() => requestRemoveMenu(menu.id)}
                      disabled={menuProfiles.length <= 1}
                    >
                      {t("menu.settings.deleteMenu")}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: "10px", display: "flex", justifyContent: "flex-start" }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (additionalMenusLocked) {
                    setMenuSyncError(t("subscription.locks.multipleMenus"));
                    return;
                  }
                  setNewMenuNameDraft("");
                  setIsCreateMenuDialogOpen(true);
                }}
                title={additionalMenusLocked ? t("subscription.locks.multipleMenus") : undefined}
              >
                {t("menu.settings.addMenu")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showMealSettingsDialog ? (
        <div className="menu-dialog-overlay" role="dialog" aria-modal="true" aria-label={t("menu.mealsConfig.title")}>
          <div className="menu-dialog" style={{ maxWidth: "680px" }}>
            <h3 style={{ marginTop: 0, marginBottom: "12px" }}>{t("menu.mealsConfig.title")}</h3>
            <div style={{ display: "grid", gap: "8px" }}>
              {orderedMealSlots.map((slot, index) => (
                <div
                  key={slot.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto auto",
                    gap: "8px",
                    alignItems: "center",
                    border: "1px solid var(--border-default)",
                    borderRadius: "8px",
                    padding: "8px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={slot.visible}
                    onChange={() => toggleMealVisibility(slot.id)}
                    title={t("menu.mealsConfig.showMeal")}
                  />
                  <input
                    className="input"
                    defaultValue={slot.name}
                    onBlur={(e) => renameMealSlot(slot.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        renameMealSlot(slot.id, (e.target as HTMLInputElement).value);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => moveMealSlot(slot.id, -1)}
                    disabled={index === 0}
                    style={{ padding: "2px 8px" }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => moveMealSlot(slot.id, 1)}
                    disabled={index === orderedMealSlots.length - 1}
                    style={{ padding: "2px 8px" }}
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>

            <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                className="input"
                type="text"
                placeholder={t("menu.mealsConfig.newMealPlaceholder")}
                value={newMealSlotName}
                onChange={(e) => setNewMealSlotName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addMealSlot();
                }}
                style={{ flex: "1 1 220px" }}
              />
              <button type="button" className="btn btn-primary" onClick={addMealSlot}>
                {t("menu.mealsConfig.addMeal")}
              </button>
            </div>

            <label style={{ marginTop: "12px", display: "inline-flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={saveMealSlotsAsDefault}
                onChange={(e) => setSaveMealSlotsAsDefault(e.target.checked)}
              />
              {t("menu.mealsConfig.useAsDefault")}
            </label>

            <div className="menu-dialog__actions">
              <button type="button" className="menu-dialog__confirm" onClick={handleMealSettingsDone}>
                {t("menu.actions.save")}
              </button>
              <button type="button" className="menu-dialog__cancel" onClick={closeMealSettingsDialog}>
                {t("menu.actions.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCreateMenuDialogOpen ? (
        <div className="menu-dialog-overlay" role="dialog" aria-modal="true" aria-label={t("menu.createMenu.title")}>
          <div className="menu-dialog" style={{ maxWidth: "420px" }}>
            <h3 style={{ marginTop: 0, marginBottom: "12px" }}>{t("menu.createMenu.title")}</h3>
            <input
              className="menu-dialog__input"
              value={newMenuNameDraft}
              onChange={(e) => setNewMenuNameDraft(e.target.value)}
              placeholder={t("menu.createMenu.namePlaceholder")}
              autoFocus
            />
            <div className="menu-dialog__actions">
              <button
                type="button"
                className="menu-dialog__confirm"
                onClick={addMenu}
                disabled={!newMenuNameDraft.trim()}
              >
                {t("menu.actions.create")}
              </button>
              <button type="button" className="menu-dialog__cancel" onClick={() => setIsCreateMenuDialogOpen(false)}>
                {t("menu.actions.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showPdfExportDialog ? (
        <div className="menu-dialog-overlay" role="dialog" aria-modal="true" aria-label={t("menu.pdfModal.title")}>
          <div className="menu-dialog" style={{ maxWidth: "460px" }}>
            <h3 style={{ marginTop: 0, marginBottom: "10px" }}>{t("menu.pdfModal.title")}</h3>
            <div style={{ display: "grid", gap: "8px" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
                <input
                  type="radio"
                  name="menuPdfMode"
                  value="menu"
                  checked={pdfExportMode === "menu"}
                  onChange={() => setPdfExportMode("menu")}
                />
                {t("menu.pdfModal.menuOnly")}
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
                <input
                  type="radio"
                  name="menuPdfMode"
                  value="menu_full"
                  checked={pdfExportMode === "menu_full"}
                  onChange={() => setPdfExportMode("menu_full")}
                />
                {t("menu.pdfModal.menuWithRecipes")}
              </label>
            </div>

            {!canUsePdfExport ? (
              <p className="muted" style={{ marginTop: "10px", marginBottom: 0 }}>
                {t("subscription.locks.pdfExportShort")}
              </p>
            ) : null}

            <div className="menu-dialog__actions">
              <button
                type="button"
                className="menu-dialog__confirm"
                onClick={() => {
                  void handleDownloadPdfFromDialog();
                }}
                disabled={!canUsePdfExport || isAnyMenuPdfExporting}
              >
                {isAnyMenuPdfExporting ? t("menu.actions.exportingPdf") : t("menu.pdfModal.download")}
              </button>
              <button type="button" className="menu-dialog__cancel" onClick={() => setShowPdfExportDialog(false)}>
                {t("menu.actions.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDeleteMenu ? (
        <div className="menu-dialog-overlay" role="dialog" aria-modal="true" aria-label={t("menu.deleteMenu.title")}>
          <div className="menu-dialog" style={{ maxWidth: "420px" }}>
            <h3 style={{ marginTop: 0, marginBottom: "8px" }}>{t("menu.deleteMenu.title")}</h3>
            <p style={{ marginTop: 0 }}>
              {t("menu.deleteMenu.confirm", { name: getMenuDisplayName(pendingDeleteMenu.name) })}
            </p>
            <div className="menu-dialog__actions">
              <button
                type="button"
                className="menu-dialog__confirm"
                style={{ background: "#9b4d3a" }}
                onClick={() => removeMenu(pendingDeleteMenu.id)}
              >
                {t("menu.actions.delete")}
              </button>
              <button type="button" className="menu-dialog__cancel" onClick={() => setPendingDeleteMenuId(null)}>
                {t("menu.actions.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DropdownMenu />
      <MoveDialog />
      {activeProductsDialog}

      <AddEditDialog
        key={
          editingItem
            ? `edit:${editingItem.cellKey}:${editingItem.index}`
            : `add:${addingItemCell ?? "closed"}`
        }
        addingItemCell={addingItemCell}
        editingItem={editingItem}
        recipes={recipes}
        mealData={mealData}
        cellPeopleCount={cellPeopleCount}
        modalRef={modalRef}
        onClose={closeAddEditDialog}
        onConfirm={(cellKey, item) => {
          // Handle the confirmation by updating mealData
          if (editingItem) {
            // Edit existing item
            setMealData((prev) => ({
              ...prev,
              [cellKey]: prev[cellKey].map((existingItem, idx) =>
                idx === editingItem.index ? item : existingItem
              ),
            }));
          } else {
            // Add new item
            setMealData((prev) => ({
              ...prev,
              [cellKey]: [...(prev[cellKey] || []), item],
            }));
          }

          if (pendingRecipeForMenu && item.type === "recipe" && item.recipeId === pendingRecipeForMenu) {
            const addedIngredients = getMenuItemIngredients(cellKey, item);

            setPendingRecipeForMenu(null);
            setMenuAddedHasIngredients(hasCountableIngredients(addedIngredients));
            setShowMenuAddedNotice(true);

            if (typeof window !== "undefined") {
              window.sessionStorage.setItem("planottoHighlightShoppingNav", "1");
              window.sessionStorage.setItem("shoppingFromMenuAdded", "1");
              window.dispatchEvent(new Event("planotto:highlight-shopping"));
            }
          }
        }}
      />

      <div className="menu-actions">
        <button
          className={canUsePdfExport ? "menu-actions__generate-btn" : "btn"}
          onClick={() => {
            setShowPdfExportDialog(true);
          }}
          disabled={isAnyMenuPdfExporting}
        >
          {isAnyMenuPdfExporting ? t("menu.actions.exportingPdf") : t("menu.actions.exportPdf")}
        </button>
        <button
          className="menu-actions__generate-btn"
          onClick={generateShoppingList}
          disabled={Object.values(mealData).filter((item) => getDisplayText(item).trim() !== "").length === 0}
        >
          {t("menu.actions.generateShoppingList")}
        </button>

        <button className="menu-actions__clear-btn" onClick={clearWeek} disabled={Object.keys(mealData).length === 0}>
          {t("menu.actions.clearPeriod")}
        </button>
      </div>
      </section>
      {confirmDialog}
    </>
  );
}

export default function MenuPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<section className="card"><h1 className="h1">{t("menu.loading")}</h1></section>}>
      <MenuPageContent />
    </Suspense>
  );
}

