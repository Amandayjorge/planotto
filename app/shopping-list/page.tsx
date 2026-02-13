"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { appendProductSuggestions } from "../lib/productSuggestions";

interface Ingredient {
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
  type: "recipe" | "text";
  recipeId?: string;
  value?: string;
  includeInShopping?: boolean;
  ingredients?: Ingredient[];
}

interface GroupedIngredient {
  name: string;
  totalAmount: number;
  unit: string;
  category: StoreCategory;
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

type StoreCategory = "Овощи" | "Мясо" | "Молочное" | "Бакалея" | "Прочее";
type StoreCategoryFilter = "all" | StoreCategory;

const STORE_CATEGORY_ORDER: StoreCategory[] = ["Овощи", "Мясо", "Молочное", "Бакалея", "Прочее"];
const PRIMARY_STORE_CATEGORIES: StoreCategory[] = STORE_CATEGORY_ORDER.filter(
  (category) => category !== "Прочее"
);
const STORE_CATEGORY_FILTERS: StoreCategoryFilter[] = ["all", ...STORE_CATEGORY_ORDER];

const STORE_CATEGORY_KEYWORDS: Record<StoreCategory, string[]> = {
  Овощи: ["овощ", "картофел", "морков", "огур", "помид", "капуст", "перец", "баклаж", "бакл", "редис", "лук", "чеснок", "зелень", "свекл", "тыкв", "шпинат"],
  Мясо: ["мяс", "куриц", "индейк", "цыплен", "фарш", "бекон", "колбас", "ветчин", "сосис", "стейк", "говяд", "свинин", "телятина"],
  Молочное: ["молок", "сыр", "творог", "кефир", "йогурт", "масло", "сливк", "сметан", "ряжен", "кумыс", "морожен"],
  Бакалея: [
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
    "мускат"
  ],
  Прочее: [],
};

const categorizeIngredient = (value: string): StoreCategory => {
  const normalized = normalizeString(value).toLowerCase();
  for (const category of PRIMARY_STORE_CATEGORIES) {
    const keywords = STORE_CATEGORY_KEYWORDS[category] || [];
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return category;
    }
  }
  return "Прочее";
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

const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const formatDate = (date: Date): string => {
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
};

const formatDisplayDate = (date: Date): string => {
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
};

const getWeekRange = (weekStart: Date, weeks: number): string => {
  const endDate = new Date(weekStart);
  endDate.setDate(endDate.getDate() + weeks * 7 - 1);
  return `${formatDisplayDate(weekStart)}–${formatDisplayDate(endDate)}`;
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

const normalizeKey = (name: string, unit: string): string => {
  return `${normalizeString(name)}|${normalizeString(unit)}`;
};

const WEEKDAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

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

const getWeekdayShort = (isoDate: string): string => {
  const date = new Date(isoDate);
  const day = date.getDay();
  return WEEKDAY_SHORT[day] || "";
};

type QuickDatePreset = "today" | "tomorrow" | "period" | "custom";

const loadManualItemsFromStorage = (): ManualShoppingItem[] => {
  if (typeof window === "undefined") return [];

  try {
    const stored = localStorage.getItem(MANUAL_ITEMS_KEY);
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

const loadPurchasedItemsForRange = (weeks: number): Record<string, boolean> => {
  if (typeof window === "undefined") return {};

  const weekStart = ensureWeekStart();
  const purchasedKey = `purchasedItems:${weekStart}:${weeks}`;
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

const getInitialSelectedDates = (weeks: number): string[] => {
  if (typeof window === "undefined") return [];
  return buildPeriodDates(ensureWeekStart(), weeks);
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

const roundAmount = (value: number): number => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

const formatAmount = (value: number): string => {
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(roundAmount(value));
};

export default function ShoppingListPage() {
  const [pantryItems, setPantryItems] = useState<PantryItem[]>(() =>
    loadPantryItemsFromStorage()
  );
  const [rangeWeeks, setRangeWeeks] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const stored = localStorage.getItem(SHOPPING_RANGE_KEY);
    return stored ? parseInt(stored, 10) : 1;
  });

  const periodDates = useMemo(() => buildPeriodDates(ensureWeekStart(), rangeWeeks), [rangeWeeks]);
  const [selectedDates, setSelectedDates] = useState<string[]>(() =>
    getInitialSelectedDates(rangeWeeks)
  );
  const [activeDatePreset, setActiveDatePreset] = useState<QuickDatePreset>("period");
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [activeStoreCategoryFilter, setActiveStoreCategoryFilter] =
    useState<StoreCategoryFilter>("all");

  const [copyConfirmation, setCopyConfirmation] = useState(false);
  const [showMenuAddedHint] = useState(() => {
    if (typeof window === "undefined") return false;
    const fromMenuAdded = window.sessionStorage.getItem("shoppingFromMenuAdded") === "1";
    if (fromMenuAdded) window.sessionStorage.removeItem("shoppingFromMenuAdded");
    return fromMenuAdded;
  });

  const guestReminderState = useMemo(() => readGuestReminderState(), []);
  const [showGuestReminder, setShowGuestReminder] = useState(guestReminderState.show);
  const guestReminderStrong = guestReminderState.strong;

  const [purchasedItems, setPurchasedItems] = useState<Record<string, boolean>>(() =>
    loadPurchasedItemsForRange(rangeWeeks)
  );

  const [manualItems, setManualItems] = useState<ManualShoppingItem[]>(() =>
    loadManualItemsFromStorage()
  );
  const [collapsedSections, setCollapsedSections] = useState<string[]>([]);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualUnit, setManualUnit] = useState("");

  // период (подпись)
  const getPeriodDisplay = () => {
    const weekStart = ensureWeekStart();
    const startDate = new Date(weekStart);
    return getWeekRange(startDate, rangeWeeks);
  };

  const handleRangeWeeksChange = (weeks: number) => {
    const weekStart = ensureWeekStart();
    const dates = buildPeriodDates(weekStart, weeks);
    setRangeWeeks(weeks);
    setSelectedDates(dates);
    setActiveDatePreset("period");
    setIsDatePickerOpen(false);
    setPurchasedItems(loadPurchasedItemsForRange(weeks));
  };

  // сохраняем rangeWeeks
  useEffect(() => {
    localStorage.setItem(SHOPPING_RANGE_KEY, rangeWeeks.toString());
  }, [rangeWeeks]);

  // сохраняем purchasedItems
  useEffect(() => {
    if (typeof window === "undefined") return;
    const weekStart = ensureWeekStart();
    const purchasedKey = `purchasedItems:${weekStart}:${rangeWeeks}`;
    localStorage.setItem(purchasedKey, JSON.stringify(purchasedItems));
  }, [purchasedItems, rangeWeeks]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(MANUAL_ITEMS_KEY, JSON.stringify(manualItems));
  }, [manualItems]);

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
      const menuBuckets: Array<{ menuData: Record<string, MenuItem[]>; cellPeopleCountMap: Record<string, number> }> = [];
      const periodDaysForList = buildPeriodDates(weekStart, rangeWeeks);
      const effectiveDays =
        selectedDates.length > 0 ? selectedDates : periodDaysForList;
      const activeDaySet = new Set(effectiveDays);

      const parseCellPeopleCount = (raw: string | null): Record<string, number> => {
        if (!raw) return {};
        try {
          const parsed = JSON.parse(raw) as Record<string, number>;
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          return {};
        }
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
              const rangeMenuParsed = JSON.parse(rangeMenuRaw) as Record<string, MenuItem[] | MenuItem>;
              const normalizedRangeMenu: Record<string, MenuItem[]> = {};
              Object.entries(rangeMenuParsed || {}).forEach(([cellKey, cellValue]) => {
                normalizedRangeMenu[cellKey] = Array.isArray(cellValue) ? cellValue : [cellValue];
              });

              menuBuckets.push({
                menuData: normalizedRangeMenu,
                cellPeopleCountMap: parseCellPeopleCount(localStorage.getItem(`cellPeopleCount:${suffix}`)),
              });
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
          const cellPeopleCountKey = `cellPeopleCount:${currentWeekKey}`;

          const storedMenu = localStorage.getItem(menuStorageKey);
          if (!storedMenu) continue;

          const menuDataParsed = JSON.parse(storedMenu) as Record<string, MenuItem[] | MenuItem>;
          const normalizedMenuData: Record<string, MenuItem[]> = {};
          Object.entries(menuDataParsed || {}).forEach(([cellKey, cellValue]) => {
            normalizedMenuData[cellKey] = Array.isArray(cellValue) ? cellValue : [cellValue];
          });

          menuBuckets.push({
            menuData: normalizedMenuData,
            cellPeopleCountMap: parseCellPeopleCount(localStorage.getItem(cellPeopleCountKey)),
          });
        }
      }

      menuBuckets.forEach(({ menuData, cellPeopleCountMap }) => {
        Object.entries(menuData).forEach(([menuKey, menuItems]) => {
          const dayKey = menuKey.substring(0, 10);
          if (activeDaySet.size > 0 && !activeDaySet.has(dayKey)) {
            return;
          }
          menuItems.forEach((menuItem) => {
            if (menuItem.type === "recipe" && menuItem.recipeId) {
              if (menuItem.ingredients?.length) {
                menuItem.ingredients.forEach((ing) => {
                  if (ing.unit !== "по вкусу") {
                    allIngredients.push({
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
                  if (ing.unit !== "по вкусу") {
                    allIngredients.push({
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
                if (ing.unit !== "по вкусу") {
                  allIngredients.push({
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
        { totalAmount: number; unit: string }
      > = {};

      allIngredients.forEach((ing) => {
        const key = normalizeKey(ing.name, ing.unit);
        if (!ingredientGroups[key]) {
          ingredientGroups[key] = { totalAmount: 0, unit: ing.unit };
        }
        ingredientGroups[key].totalAmount += ing.amount;
      });

      const groupedList: GroupedIngredient[] = Object.entries(ingredientGroups)
        .map(([key, data]) => {
          const [name] = key.split("|");
          const normalizedName = name;
          return {
            name: normalizedName.charAt(0).toUpperCase() + normalizedName.slice(1),
            totalAmount: data.totalAmount,
            unit: data.unit,
            category: categorizeIngredient(normalizedName),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      return groupedList;
    } catch (error) {
      console.error("Failed to generate shopping list:", error);
      return [];
    }
  }, [rangeWeeks, selectedDates]);

  // сохраняем pantryItems
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(pantryItems));
  }, [pantryItems]);

  const getRemainingAmount = (name: string, unit: string, requiredAmount: number) => {
    const normalizedIngredientName = name.toLowerCase().trim();
    const pantryItem = pantryItems.find(item => 
      item.name.toLowerCase().trim() === normalizedIngredientName && 
      item.unit === unit
    );
    const haveAmount = pantryItem?.amount || 0;
    return Math.max(0, requiredAmount - haveAmount);
  };

  const isPurchased = (name: string, unit: string) => {
    const key = normalizeKey(name, unit);
    return purchasedItems[key] || false;
  };

  const togglePurchasedItem = (name: string, unit: string) => {
    const key = normalizeKey(name, unit);
    const wasPurchased = purchasedItems[key] || false;
    const isNowPurchased = !wasPurchased;
    
    setPurchasedItems((prev) => ({ ...prev, [key]: isNowPurchased }));
    
    // Add to pantry when item is marked as purchased
    if (isNowPurchased) {
      // Find the ingredient amount from the shopping list
      const item = shoppingList.find(item => 
        normalizeKey(item.name, item.unit) === key
      );
      
      if (item) {
        appendProductSuggestions([item.name]);

        setPantryItems(prev => {
          const normalizedIngredientName = item.name.toLowerCase().trim();
          const existingIndex = prev.findIndex(pantryItem => 
            pantryItem.name.toLowerCase().trim() === normalizedIngredientName && 
            pantryItem.unit === item.unit
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
    category: "Прочее",
    id: manual.id,
    isManual: true,
  }));

  const filterUnpurchased = (items: GroupedIngredient[]) =>
    items.filter((item) => {
      const remaining = getRemainingAmount(item.name, item.unit, item.totalAmount);
      if (isPurchased(item.name, item.unit)) return false;
      return remaining > 0;
    });

  const filterPurchased = (items: GroupedIngredient[]) =>
    items.filter((item) => isPurchased(item.name, item.unit));

  const filteredMenuUnpurchased = filterUnpurchased(shoppingList);
  const filteredMenuPurchased = filterPurchased(shoppingList);

  const manualCategoryMatchesFilter =
    activeStoreCategoryFilter === "all" || activeStoreCategoryFilter === "Прочее";

  const filteredManualUnpurchased = manualCategoryMatchesFilter
    ? filterUnpurchased(manualListItems)
    : [];

  const filteredManualPurchased = manualCategoryMatchesFilter
    ? filterPurchased(manualListItems)
    : [];

  const combinedUnpurchasedList = [...filteredMenuUnpurchased, ...filteredManualUnpurchased];
  const combinedPurchasedList = [...filteredMenuPurchased, ...filteredManualPurchased];

  const purchasedCount = combinedPurchasedList.length;
  const totalCount = combinedUnpurchasedList.length;
  const totalPositions = shoppingList.length + manualItems.length;
  const progressPercent =
    totalPositions === 0 ? 0 : Math.round((purchasedCount / totalPositions) * 100);

  const visibleItemsCount =
    combinedUnpurchasedList.length + combinedPurchasedList.length;

  const currentCategoryOrder =
    activeStoreCategoryFilter === "all" ? STORE_CATEGORY_ORDER : [activeStoreCategoryFilter];

  const categorySections = currentCategoryOrder
    .map((category) => {
      const itemsInCategory = [
        ...filteredMenuUnpurchased.filter((item) => item.category === category),
        ...filteredMenuPurchased.filter((item) => item.category === category),
      ];
      return { category, items: itemsInCategory };
    })
    .filter((section) => section.items.length > 0);

  const manualSectionItems = [...filteredManualUnpurchased, ...filteredManualPurchased];

  const handleCopyList = () => {
    const periodDisplay = getPeriodDisplay();
    const listText = combinedUnpurchasedList
      .map((item) => {
        const remaining = getRemainingAmount(item.name, item.unit, item.totalAmount);
        return `• ${item.name} — ${formatAmount(remaining)} ${item.unit}`;
      })
      .join("\n");

    const fullText = `Список покупок за период: ${periodDisplay}\n\n${listText}`;

    navigator.clipboard
      .writeText(fullText)
      .then(() => {
        setCopyConfirmation(true);
        setTimeout(() => setCopyConfirmation(false), 2000);
      })
      .catch((err) => console.error("Failed to copy text: ", err));
  };

  const handlePrintList = () => window.print();

  const manualSectionLabel = "Ручные позиции";
  const toggleSectionCollapse = (section: string) => {
    setCollapsedSections((prev) =>
      prev.includes(section) ? prev.filter((name) => name !== section) : [...prev, section]
    );
  };

  const isSectionCollapsed = (section: string) => collapsedSections.includes(section);

  const renderShoppingItem = (item: GroupedIngredient) => {
    const remainingAmount = getRemainingAmount(item.name, item.unit, item.totalAmount);
    const haveEnough = remainingAmount <= 0;
    const purchased = isPurchased(item.name, item.unit);

    return (
      <div
        key={item.id ?? `${item.name}-${item.unit}`}
        className={`shopping-list_item ${haveEnough ? "shopping-list_item--have" : ""} ${
          purchased ? "shopping-list__item--purchased" : ""
        }`}
      >
        <div className="shopping-list__main">
          <span className="shopping-list__dish-name">{item.name}</span>

          <div className="shopping-list__amounts">
            <span className="shopping-list__required">
              Нужно: {formatAmount(item.totalAmount)} {item.unit}
            </span>

            <span
              className={`shopping-list__buy ${
                haveEnough ? "shopping-list__buy--enough" : ""
              }`}
            >
              Купить: {formatAmount(remainingAmount)} {item.unit}
            </span>
          </div>
        </div>

        <div className="shopping-list__purchased">
          <button
            type="button"
            className={`shopping-list__purchased-btn ${
              purchased ? "shopping-list__purchased-btn--active" : ""
            }`}
            onClick={() => togglePurchasedItem(item.name, item.unit)}
            aria-pressed={purchased}
            aria-label={
              purchased
                ? `Снять отметку "Куплено" для ${item.name}`
                : `Отметить ${item.name} как куплено`
            }
          >
            Куплено
          </button>
        </div>

        {haveEnough && <span className="shopping-list__status">✓ Есть дома</span>}
      </div>
    );
  };

  const todayIso = formatDate(new Date());
  const tomorrowIso = formatDate(addDays(new Date(), 1));
  const getEffectivePeriodDates = (): string[] =>
    periodDates.length > 0
      ? periodDates
      : buildPeriodDates(ensureWeekStart(), rangeWeeks);

  const handleQuickDatePreset = (preset: QuickDatePreset) => {
    if (preset === "custom") return;

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
    setIsDatePickerOpen(false);
  };

  const toggleDaySelection = (date: string) => {
    setActiveDatePreset("custom");
    setSelectedDates((prev) => {
      const alreadySelected = prev.includes(date);
      if (alreadySelected) {
        return prev.filter((day) => day !== date);
      }

      const next = [...prev, date];
      if (periodDates.length > 0) {
        const order = new Map(periodDates.map((day, index) => [day, index]));
        next.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      }
      return next;
    });
  };

  return (
    <section className="card">
      <div className="shopping-list__header">
        <h1 className="h1">Список покупок</h1>

        <div className="shopping-list__period">
          <label className="shopping-list__period-label">
            Период:
            <select
              className="shopping-list__period-select"
              value={rangeWeeks}
              onChange={(e) => handleRangeWeeksChange(parseInt(e.target.value, 10))}
            >
              <option value={1}>1 неделя</option>
              <option value={2}>2 недели</option>
              <option value={3}>3 недели</option>
              <option value={4}>4 недели</option>
            </select>
          </label>

            <span className="shopping-list__period-range">{getPeriodDisplay()}</span>
        </div>

        <div className="shopping-list__date-filter">
          <div className="shopping-list__quick-buttons">
            <button
              type="button"
              className={`shopping-list__quick-btn ${
                activeDatePreset === "today" ? "shopping-list__quick-btn--active" : ""
              }`}
              onClick={() => handleQuickDatePreset("today")}
            >
              Сегодня
            </button>
            <button
              type="button"
              className={`shopping-list__quick-btn ${
                activeDatePreset === "tomorrow" ? "shopping-list__quick-btn--active" : ""
              }`}
              onClick={() => handleQuickDatePreset("tomorrow")}
            >
              Завтра
            </button>
            <button
              type="button"
              className={`shopping-list__quick-btn ${
                activeDatePreset === "period" ? "shopping-list__quick-btn--active" : ""
              }`}
              onClick={() => handleQuickDatePreset("period")}
            >
              Весь период
            </button>
          </div>

          <button
            type="button"
            className="shopping-list__add-manual-btn"
            onClick={() => setIsManualModalOpen(true)}
          >
            + Добавить позицию
          </button>

          <button
            type="button"
            className="shopping-list__custom-days-btn"
            onClick={() => setIsDatePickerOpen((prev) => !prev)}
          >
            Выбрать дни
          </button>
        </div>

        {isDatePickerOpen && periodDates.length > 0 && (
          <div className="shopping-list__date-grid">
            {periodDates.map((date) => {
              const isSelected = selectedDates.includes(date);
              return (
                <button
                  key={date}
                  type="button"
                  className={`shopping-list__date-cell ${
                    isSelected ? "shopping-list__date-cell--selected" : ""
                  }`}
                  aria-pressed={isSelected}
                  onClick={() => toggleDaySelection(date)}
                >
                  <span className="shopping-list__date-cell-day">{getWeekdayShort(date)}</span>
                  <span className="shopping-list__date-cell-date">{formatDisplayDate(new Date(date))}</span>
                </button>
              );
            })}
          </div>
        )}


        {showMenuAddedHint && (
          <p className="muted" style={{ marginTop: "8px", marginBottom: 0, fontSize: "13px" }}>
            Ингредиенты из меню уже добавлены. Можно отмечать купленные товары.
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
                ? "Чтобы данные не потерялись, зарегистрируйтесь."
                : "Чтобы сохранить ваши рецепты и меню, создайте аккаунт."}
            </p>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px", marginTop: "8px" }}>
              <Link href="/auth" className="btn btn-primary" onClick={() => setShowGuestReminder(false)}>
                Создать аккаунт
              </Link>
              <button
                type="button"
                className="menu-first-onboarding__skip"
                style={{ fontSize: "12px" }}
                onClick={() => setShowGuestReminder(false)}
              >
                Позже
              </button>
            </div>
          </div>
        )}

        {shoppingList.length > 0 && (
          <>
            <div className="shopping-list__progress">
              <div className="shopping-list__progress-item">
                <span className="shopping-list__progress-number">{totalPositions}</span>
                <span className="shopping-list__progress-label">позиций</span>
              </div>
              <div className="shopping-list__progress-item">
                <span className="shopping-list__progress-number">{purchasedCount}</span>
                <span className="shopping-list__progress-label">куплено</span>
              </div>
              <div className="shopping-list__progress-item">
                <span className="shopping-list__progress-number">{totalCount}</span>
                <span className="shopping-list__progress-label">осталось</span>
              </div>
            </div>
            <div className="shopping-list__progress-meter">
              <div
                className="shopping-list__progress-meter-fill"
                style={{ width: `${progressPercent}%` }}
                aria-hidden="true"
              />
              <span className="shopping-list__progress-meter-label">
                {progressPercent}% куплено
              </span>
            </div>

            <div className="shopping-list__category-filter">
              {STORE_CATEGORY_FILTERS.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={`shopping-list__category-btn ${
                    activeStoreCategoryFilter === category ? "shopping-list__category-btn--active" : ""
                  }`}
                  onClick={() => setActiveStoreCategoryFilter(category)}
                  aria-pressed={activeStoreCategoryFilter === category}
                >
                  {category === "all" ? "Все категории" : category}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {shoppingList.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__title">Список покупок пока пуст</div>
          <div className="empty-state__description">
            Список покупок формируется автоматически из меню и рецептов.
          </div>
          <div className="empty-state__description">
            Он учитывает кладовку и приоритеты периода.
          </div>
          <div className="empty-state__description">Пример: молоко, яйца, творог.</div>
          <div style={{ marginTop: "16px", display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
            <Link href="/menu" className="btn btn-primary">
              Составить меню
            </Link>
            <Link href="/recipes/new" className="btn btn-add">
              Добавить рецепт
            </Link>
          </div>
          <div style={{ marginTop: "12px", fontSize: "13px", color: "var(--text-tertiary)" }}>
            Продукты, которые есть дома, автоматически исключаются из списка.
          </div>
        </div>
      ) : (
        <div>
          <div className="shopping-list__controls">
            <div className="shopping-list__exports">
              <button className="shopping-list__export-btn" onClick={handleCopyList}>
                Скопировать список
              </button>
              <button className="shopping-list__export-btn" onClick={handlePrintList}>
                Печать
              </button>

              {copyConfirmation && (
                <span className="shopping-list__copy-confirmation">Скопировано</span>
              )}
            </div>
          </div>

          <p className="muted">
            Ингредиенты из выбранных рецептов ({visibleItemsCount} наименований):
          </p>

          <div className="shopping-list">
            {categorySections.length === 0 && manualSectionItems.length === 0 ? (
              <p className="muted shopping-list__empty-filter">
                В выбранной категории пока нет позиций.
              </p>
            ) : (
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
                            {section.category}
                          </span>
                          <span className="shopping-list__category-count">
                            {section.items.length} позиций
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
                {manualSectionItems.length > 0 && manualCategoryMatchesFilter && (
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
                          {manualSectionItems.length} позиций
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
            )}
          </div>

          <div className="shopping-list__actions">
            <Link href="/menu" className="shopping-list__link">
              ← Вернуться к меню
            </Link>
          </div>
        </div>
      )}
      {isManualModalOpen && (
        <div className="shopping-list__manual-modal" role="dialog" aria-modal="true">
          <div className="shopping-list__manual-dialog card">
            <div className="shopping-list__manual-header">
              <span>Добавить позицию</span>
              <button
                type="button"
                className="shopping-list__manual-close"
                onClick={() => setIsManualModalOpen(false)}
                aria-label="Закрыть форму"
              >
                ×
              </button>
            </div>

            <div className="shopping-list__manual-field">
              <label>Название</label>
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="Например, лимон"
                className="shopping-list__manual-input"
                autoFocus
              />
            </div>

            <div className="shopping-list__manual-field">
              <label>Количество</label>
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
              <label>Единица (по желанию)</label>
              <input
                type="text"
                value={manualUnit}
                onChange={(e) => setManualUnit(e.target.value)}
                placeholder="шт, г, мл..."
                className="shopping-list__manual-input"
              />
            </div>

            <div className="shopping-list__manual-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setIsManualModalOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAddManualItem}
                disabled={!manualName.trim()}
              >
                Добавить
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

