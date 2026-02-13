"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import ProductAutocompleteInput from "../components/ProductAutocompleteInput";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";
import { getMenuSuggestion } from "../lib/aiAssistantClient";
import { getCurrentUserId, listMyRecipes } from "../lib/recipesSupabase";
import { isSupabaseConfigured } from "../lib/supabaseClient";
import {
  copyPublicWeekToMine,
  getMineWeekMenu,
  getPublicWeekMenuById,
  listPublicWeekSummaries,
  type MenuWeekVisibility,
  type PublicWeekSummary,
  upsertMineWeekMenu,
} from "../lib/weeklyMenusSupabase";

const MENU_STORAGE_KEY = "weeklyMenu";
const RECIPES_STORAGE_KEY = "recipes";
const CELL_PEOPLE_COUNT_KEY = "cellPeopleCount";
const RANGE_STATE_KEY = "selectedMenuRange";
const WEEK_START_KEY = "selectedWeekStart";
const PANTRY_STORAGE_KEY = "pantry";
const MENU_FIRST_VISIT_ONBOARDING_KEY = "menuFirstVisitOnboardingSeen";
const RECIPES_FIRST_FLOW_KEY = "recipesFirstFlowActive";
const GUEST_REMINDER_VISITS_KEY = "guestReminderVisits";
const GUEST_REMINDER_PERIOD_ATTEMPTS_KEY = "guestReminderPeriodAttempts";
const GUEST_REMINDER_PENDING_KEY = "guestReminderPending";
const GUEST_REMINDER_VISITS_THRESHOLD = 3;
const GUEST_REMINDER_RECIPES_THRESHOLD = 3;
const DEFAULT_MEALS = ["Завтрак", "Обед", "Ужин"] as const;
const MEAL_LIBRARY = ["Завтрак", "Обед", "Ужин", "Перекус", "Выпечка", "Суп", "Заготовки", "Ужин"] as const;

const INGREDIENT_UNITS = ["г", "кг", "мл", "л", "шт", "ч.л.", "ст.л.", "по вкусу"];
const DEFAULT_UNIT = "г";
const RECIPE_CATEGORIES = ["Завтрак", "Обед", "Ужин", "Десерт", "Дополнительно"];

interface Ingredient {
  id: string;
  name: string;
  amount: number;
  unit: string;
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

interface Recipe {
  id: string;
  title: string;
  ingredients?: Ingredient[];
  categories?: string[];
  notes?: string;
  timesCooked?: number;
  servings?: number;
}

type ActiveProductScope = "today" | "this_week" | "until_date";

interface ActivePeriodProduct {
  id: string;
  name: string;
  scope: ActiveProductScope;
  untilDate: string;
  prefer: boolean;
}

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
      categories: Array.isArray(found.categories) ? found.categories : [],
      notes: String(found.notes || ""),
      timesCooked: Number(found.timesCooked || 0),
      servings: Number(found.servings || 2),
    };
  } catch {
    return null;
  }
};

// Helper function to format ingredient display
const formatIngredient = (ingredient: Ingredient): string => {
  if (ingredient.unit === "по вкусу") {
    return `${ingredient.name} — по вкусу`;
  }
  return `${ingredient.amount} ${ingredient.unit} ${ingredient.name}`;
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

const formatDisplayDate = (date: Date): string => {
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
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

const getRangeDisplay = (startRaw: string, endRaw: string): string => {
  const start = parseDateSafe(startRaw);
  const end = parseDateSafe(endRaw);
  if (!start || !end) return "";
  return `${formatDisplayDate(start)}-${formatDisplayDate(end)}`;
};

const getWeekdayLabel = (raw: string): string => {
  const date = parseDateSafe(raw);
  if (!date) return "";
  const text = date.toLocaleDateString("ru-RU", { weekday: "short" }).replace(".", "");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const getWeekdayLong = (raw: string): string => {
  const date = parseDateSafe(raw);
  if (!date) return "";
  return date.toLocaleDateString("ru-RU", { weekday: "long" });
};

const normalizeMealLabel = (value: string): (typeof DEFAULT_MEALS)[number] | null => {
  const normalized = value.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return null;

  if (/(\u0437\u0430\u0432\u0442\u0440\u0430\u043a|\u0443\u0442\u0440|\u043a\u0430\u0448\u0430|\u043e\u043c\u043b\u0435\u0442|\u043e\u043b\u0430\u0434|\u0431\u043b\u0438\u043d)/u.test(normalized)) {
    return DEFAULT_MEALS.find((meal) => meal.toLocaleLowerCase("ru-RU").includes("\u0437\u0430\u0432\u0442\u0440\u0430\u043a")) || null;
  }

  if (/(\u043e\u0431\u0435\u0434|\u0441\u0443\u043f)/u.test(normalized)) {
    return DEFAULT_MEALS.find((meal) => meal.toLocaleLowerCase("ru-RU").includes("\u043e\u0431\u0435\u0434")) || null;
  }

  if (/(\u0443\u0436\u0438\u043d|\u0432\u0435\u0447\u0435\u0440)/u.test(normalized)) {
    return DEFAULT_MEALS.find((meal) => meal.toLocaleLowerCase("ru-RU").includes("\u0443\u0436\u0438\u043d")) || null;
  }

  return null;
};

const resolvePreferredMealForRecipe = (
  recipe: (Recipe & { tags?: string[] }) | undefined,
  mealFromQueryRaw: string
): (typeof DEFAULT_MEALS)[number] => {
  const fromQuery = normalizeMealLabel(mealFromQueryRaw);
  if (fromQuery) return fromQuery;

  const text = [
    recipe?.title || "",
    recipe?.notes || "",
    ...(recipe?.categories || []),
    ...((recipe?.tags || []) as string[]),
  ]
    .join(" ")
    .toLocaleLowerCase("ru-RU");

  const fromRecipe = normalizeMealLabel(text);
  if (fromRecipe) return fromRecipe;

  return DEFAULT_MEALS.find((meal) => meal.toLocaleLowerCase("ru-RU").includes("\u0443\u0436\u0438\u043d")) || DEFAULT_MEALS[0];
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
  // Local form state
  const [localItemType, setLocalItemType] = useState<"recipe" | "text">("recipe");
  const [localText, setLocalText] = useState("");
  const [localRecipeId, setLocalRecipeId] = useState("");
  const [localIncludeInShopping, setLocalIncludeInShopping] = useState(true);
  const [localIngredients, setLocalIngredients] = useState<Ingredient[]>([
    { id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT },
  ]);
  const productSuggestions = loadProductSuggestions();
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<number | null>(null);
  const [localPeopleInput, setLocalPeopleInput] = useState("1");
  const [localCategoryFilter, setLocalCategoryFilter] = useState<string>("Все");

  const getEffectivePeopleCount = (cellKey: string) => {
    return cellPeopleCount[cellKey] || 1;
  };

  // Initialize form when opening or editing
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (!addingItemCell) return;

    if (editingItem) {
      // Edit mode - load existing data
      const item = mealData[editingItem.cellKey]?.[editingItem.index];
      if (item) {
        if (item.type === "recipe") {
          setLocalItemType("recipe");
          setLocalRecipeId(item.recipeId || "");
          setLocalText("");
          setLocalIncludeInShopping(item.includeInShopping ?? true);
          setLocalIngredients(item.ingredients || [{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
        } else {
          setLocalItemType("text");
          setLocalText(item.value || "");
          setLocalRecipeId("");
          setLocalIncludeInShopping(item.includeInShopping ?? true);
          setLocalIngredients(item.ingredients || [{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
        }

        const count = getEffectivePeopleCount(editingItem.cellKey);
        setLocalPeopleInput(count.toString());
      }
    } else {
      // Add mode - reset to defaults
      setLocalItemType("recipe");
      setLocalText("");
      setLocalRecipeId("");
      setLocalIncludeInShopping(true);
      setLocalIngredients([{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
      const count = getEffectivePeopleCount(addingItemCell);
      setLocalPeopleInput(count.toString());
    }
    setLocalCategoryFilter("Все");
    setActiveSuggestionIndex(null);
  }, [addingItemCell, editingItem, mealData, cellPeopleCount]);

  const getFilteredRecipes = () => {
    if (localCategoryFilter === "Все") return recipes;
    if (localCategoryFilter === "Без категории") {
      return recipes.filter((recipe) => !recipe.categories || recipe.categories.length === 0);
    }
    return recipes.filter((recipe) => recipe.categories?.includes(localCategoryFilter));
  };

  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string | number) => {
    setLocalIngredients((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const addIngredientField = () => {
    setLocalIngredients((prev) => [...prev, { id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
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
        ?.filter((ing) => ing.name.trim() && (ing.unit === "по вкусу" || ing.amount > 0))
        .map((ing) => ({
          ...ing,
          amount: ing.unit === "по вкусу" ? 0 : ing.amount * scale,
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
            ? localIngredients.filter((ing) => ing.name.trim() && (ing.unit === "по вкусу" || ing.amount > 0))
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
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.5)",
        zIndex: 10000,
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
          borderRadius: "8px",
          padding: "20px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          minWidth: "400px",
          maxWidth: "90vw",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, color: "#333" }}>{editingItem ? "Редактировать блюдо" : "Добавить блюдо"}</h3>

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
            title="Закрыть"
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
            Рецепт
          </label>
          <label>
            <input
              type="radio"
              name="itemType"
              value="text"
              checked={localItemType === "text"}
              onChange={(e) => setLocalItemType(e.target.value as "recipe" | "text")}
            />
            Текст
          </label>
        </div>

        <div className="menu-dialog__people-count">
          <label>
            Сколько порций?
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

        {localItemType === "recipe" ? (
          <div className="menu-dialog__recipe-selector">
            <div className="menu-dialog__category-filter">
              <label>
                Категория:
                <select
                  value={localCategoryFilter}
                  onChange={(e) => setLocalCategoryFilter(e.target.value)}
                  className="menu-dialog__select"
                >
                  <option value="Все">Все</option>
                  {RECIPE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                  <option value="Без категории">Без категории</option>
                </select>
              </label>
            </div>

            <select value={localRecipeId} onChange={(e) => setLocalRecipeId(e.target.value)} className="menu-dialog__select">
              <option value="">Выберите рецепт...</option>
              {getFilteredRecipes().map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.title}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="menu-dialog__text-input">
            <input
              type="text"
              value={localText}
              onChange={(e) => setLocalText(e.target.value)}
              placeholder="Введите текст..."
              className="menu-dialog__input"
            />

            <div className="menu-dialog__shopping-option">
              <label>
                <input
                  type="checkbox"
                  checked={localIncludeInShopping}
                  onChange={(e) => setLocalIncludeInShopping(e.target.checked)}
                />
                Включить в список покупок
              </label>
            </div>

            {localIncludeInShopping && (
              <div className="menu-dialog__ingredients">
                <h4>Ингредиенты:</h4>

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
                        placeholder="Название"
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
                      placeholder="Кол-во"
                      className="menu-dialog__ingredient-amount"
                      min="0"
                      step="0.1"
                    />

                    {INGREDIENT_UNITS.includes(ingredient.unit) ? (
                      <select
                        value={ingredient.unit}
                        onChange={(e) => handleIngredientChange(index, "unit", e.target.value)}
                        className="menu-dialog__ingredient-unit"
                      >
                        {INGREDIENT_UNITS.map((unit) => (
                          <option key={unit} value={unit}>
                            {unit}
                          </option>
                        ))}
                        <option value="другое">другое</option>
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={ingredient.unit}
                        onChange={(e) => handleIngredientChange(index, "unit", e.target.value)}
                        placeholder="ед. изм."
                        className="menu-dialog__ingredient-unit"
                      />
                    )}

                    <button
                      type="button"
                      onClick={() => removeIngredientField(index)}
                      className="menu-dialog__ingredient-remove"
                      title="Удалить ингредиент"
                    >
                      ×
                    </button>
                  </div>
                ))}

                <button type="button" onClick={addIngredientField} className="menu-dialog__add-ingredient">
                  + Добавить ингредиент
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
            Сохранить
          </button>

          <button type="button" onClick={onClose} className="menu-dialog__cancel">
            Отмена
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
});

AddEditDialog.displayName = "AddEditDialog";

function MenuPageContent() {
  const meals = ["Завтрак", "Обед", "Ужин"];
  const initialRangeStart = formatDate(getMonday(new Date()));
  const initialRangeEnd = formatDate(addDays(getMonday(new Date()), 6));

  const [mealData, setMealData] = useState<Record<string, MenuItem[]>>({});
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);

  const [cellPeopleCount, setCellPeopleCount] = useState<Record<string, number>>({});
  const [weekStart, setWeekStart] = useState<string>(() => initialRangeStart);
  const [periodEnd, setPeriodEnd] = useState<string>(() => initialRangeEnd);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("7d");
  const [customStartInput, setCustomStartInput] = useState<string>(() => initialRangeStart);
  const [customEndInput, setCustomEndInput] = useState<string>(() => initialRangeEnd);

  const [addingItemCell, setAddingItemCell] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const [newItemType, setNewItemType] = useState<"recipe" | "text">("recipe");
  const [newItemText, setNewItemText] = useState("");
  const [newItemRecipeId, setNewItemRecipeId] = useState("");
  const [newItemIncludeInShopping, setNewItemIncludeInShopping] = useState(true);
  const [newItemIngredients, setNewItemIngredients] = useState<Ingredient[]>([
    { id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT },
  ]);
  const [newItemPeopleCount, setNewItemPeopleCount] = useState(1);
  const [peopleInput, setPeopleInput] = useState("1");

  const [recipeCategoryFilter, setRecipeCategoryFilter] = useState<string>("Все");

  const [openMoreMenu, setOpenMoreMenu] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ cellKey: string; index: number; rect: DOMRect } | null>(null);

  const [editingItem, setEditingItem] = useState<{ cellKey: string; index: number } | null>(null);

  const [movingItem, setMovingItem] = useState<{ cellKey: string; index: number } | null>(null);
  const [moveTargetDay, setMoveTargetDay] = useState<string>("");
  const [moveTargetMeal, setMoveTargetMeal] = useState<string>("");
  const dialogMouseDownRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(RANGE_STATE_KEY, JSON.stringify({ start: weekStart, end: periodEnd }));
      localStorage.setItem(WEEK_START_KEY, weekStart);
    } catch {
      // ignore localStorage write issues
    }
  }, [weekStart, periodEnd]);

  const router = useRouter();
  const searchParams = useSearchParams();
  const forceFirstFromQuery = searchParams.get("first") === "1";

  const [cookedStatus, setCookedStatus] = useState<Record<string, boolean>>({});
  const [pantry, setPantry] = useState<PantryItem[]>([]);
  const [showPantryDialog, setShowPantryDialog] = useState<{ cellKey: string; index: number } | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [menuMode, setMenuMode] = useState<"mine" | "public">("mine");
  const [weekVisibility, setWeekVisibility] = useState<MenuWeekVisibility>("private");
  const [publicWeeks, setPublicWeeks] = useState<PublicWeekSummary[]>([]);
  const [selectedPublicWeekId, setSelectedPublicWeekId] = useState("");
  const [menuSyncError, setMenuSyncError] = useState("");
  const [activeProducts, setActiveProducts] = useState<ActivePeriodProduct[]>([]);
  const [activeProductName, setActiveProductName] = useState("");
  const [activeProductScope, setActiveProductScope] = useState<ActiveProductScope>("this_week");
  const [activeProductUntilDate, setActiveProductUntilDate] = useState(() => formatDate(new Date()));
  const [knownProductSuggestions, setKnownProductSuggestions] = useState<string[]>(() => loadProductSuggestions());
  const [showFirstVisitOnboarding, setShowFirstVisitOnboarding] = useState(() => forceFirstFromQuery);
  const [showCalendarInlineHint, setShowCalendarInlineHint] = useState(false);
  const [forcedOnboardingFlow, setForcedOnboardingFlow] = useState(() => forceFirstFromQuery);
  const [pendingRecipeForMenu, setPendingRecipeForMenu] = useState<string | null>(null);
  const [quickRecipeConfirm, setQuickRecipeConfirm] = useState<QuickRecipeConfirm | null>(null);
  const [showMenuAddedNotice, setShowMenuAddedNotice] = useState(false);
  const [menuAddedHasIngredients, setMenuAddedHasIngredients] = useState(false);
  const [showGuestReminder, setShowGuestReminder] = useState(false);
  const [guestReminderStrong, setGuestReminderStrong] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const guestVisitTrackedRef = useRef(false);

  const rangeKey = `${weekStart}__${periodEnd}`;
  const periodDays = getRangeLengthDays(weekStart, periodEnd);
  const dayKeys = useMemo(() => buildDayKeys(weekStart, periodEnd), [weekStart, periodEnd]);
  const dayEntries = useMemo(
    () =>
      dayKeys
        .map((dateKey) => {
          const date = parseDateSafe(dateKey);
          if (!date) return null;
          return {
            dateKey,
            dayLabel: getWeekdayLabel(dateKey),
            displayDate: formatDisplayDate(date),
          };
        })
        .filter((entry): entry is { dateKey: string; dayLabel: string; displayDate: string } => Boolean(entry)),
    [dayKeys]
  );
  const getMenuStorageKey = () => `${MENU_STORAGE_KEY}:${rangeKey}`;
  const getCellPeopleCountKey = () => `${CELL_PEOPLE_COUNT_KEY}:${rangeKey}`;
  const getCookedStatusKey = () => `cookedStatus:${rangeKey}`;
  const getActiveProductsKey = () => `activeProducts:${rangeKey}`;
  const getCellKey = (day: string, meal: string) => `${day}-${meal}`;
  const persistMenuSnapshot = (
    nextMealData: Record<string, MenuItem[]>,
    nextCellPeopleCount: Record<string, number> = cellPeopleCount
  ) => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(getMenuStorageKey(), JSON.stringify(nextMealData));
      localStorage.setItem(getCellPeopleCountKey(), JSON.stringify(nextCellPeopleCount));
    } catch {
      // ignore local storage write errors
    }
  };
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
    setNewItemIngredients([{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
    setNewItemPeopleCount(1);
    setPeopleInput("1");
    setRecipeCategoryFilter("Все");
  };

  const closeMoveDialog = () => {
    setMovingItem(null);
    setMoveTargetDay("");
    setMoveTargetMeal("");
  };

  const closePantryDialog = () => {
    setShowPantryDialog(null);
  };

  const resetAllModalStates = () => {
    closeDropdownMenu();
    closeAddEditDialog();
    closeMoveDialog();
    closePantryDialog();
  };

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
    setShowCalendarInlineHint(true);
    setForcedOnboardingFlow(false);
    localStorage.setItem(MENU_FIRST_VISIT_ONBOARDING_KEY, "1");
    router.replace("/menu");
  };

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
        return;
      }
    } else {
      nextEnd = addDays(nextStart, 6);
    }

    setPeriodPreset(preset);
    setWeekStart(formatDate(nextStart));
    setPeriodEnd(formatDate(nextEnd));
    setCustomStartInput(formatDate(nextStart));
    setCustomEndInput(formatDate(nextEnd));

    if (!currentUserId) {
      incrementGuestCounter(GUEST_REMINDER_PERIOD_ATTEMPTS_KEY);
    }
  };

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

  const resolveUntilDateByScope = (scope: ActiveProductScope): string => {
    if (scope === "today") return formatDate(new Date());
    if (scope === "this_week") return periodEnd;
    return activeProductUntilDate || periodEnd;
  };

  const addActiveProduct = () => {
    const name = activeProductName.trim();
    if (!name) return;

    const untilDate = resolveUntilDateByScope(activeProductScope);
    const normalizedName = name.toLowerCase();

    setActiveProducts((prev) => {
      const existing = prev.find((item) => item.name.toLowerCase() === normalizedName);
      if (existing) {
        return prev.map((item) =>
          item.id === existing.id
            ? { ...item, name, scope: activeProductScope, untilDate, prefer: true }
            : item
        );
      }
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          name,
          scope: activeProductScope,
          untilDate,
          prefer: true,
        },
      ];
    });

    appendProductSuggestions([name]);
    setKnownProductSuggestions(loadProductSuggestions());
    setActiveProductName("");
  };

  const removeActiveProduct = (id: string) => {
    setActiveProducts((prev) => prev.filter((item) => item.id !== id));
  };

  const toggleActiveProductPriority = (id: string) => {
    setActiveProducts((prev) =>
      prev.map((item) => (item.id === id ? { ...item, prefer: !item.prefer } : item))
    );
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
      const composedConstraints = [prompt.trim(), prioritizedProducts ? `Приоритетные продукты: ${prioritizedProducts}.` : ""]
        .filter(Boolean)
        .join(" ");

      const data = await getMenuSuggestion({
        peopleCount,
        days: Math.max(1, periodDays),
        constraints: composedConstraints,
        newDishPercent: 40,
        recipes: recipes.map((recipe) => recipe.title).slice(0, 120),
      });

      const message = data.message || "ИИ не смог предложить.";
      window.dispatchEvent(
        new CustomEvent("planotto:menu-ai-status", {
          detail: { isLoading: false, message },
        })
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось получить предложение ИИ.";
      window.dispatchEvent(
        new CustomEvent("planotto:menu-ai-status", {
          detail: { isLoading: false, message: text },
        })
      );
    }
  }, [activeProducts, cellPeopleCount, periodDays, recipes]);

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
        return "Не найдена таблица weekly_menus в Supabase. Выполните SQL из supabase/schema.sql.";
      }

      if (message) return message;
    }

    return "Ошибка сохранения меню.";
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

  const isDayInPast = (dayKey: string): boolean => {
    const currentDate = parseDateSafe(dayKey);
    if (!currentDate) return false;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    currentDate.setHours(0, 0, 0, 0);

    return currentDate < today;
  };

  const getDefaultCookedStatus = (dayKey: string, itemId?: string): boolean => {
    if (itemId && cookedStatus[itemId] !== undefined) return cookedStatus[itemId];
    return isDayInPast(dayKey);
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
      return menuItem.ingredients;
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
      .filter((ingredient) => ingredient.name.trim().length > 0 && ingredient.amount > 0)
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

  const handleConfirmCooked = () => {
    if (!showPantryDialog) return;
    const { cellKey, index } = showPantryDialog;
    const items = mealData[cellKey];
    if (!items || !items[index]) return;

    const menuItem = items[index];
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], cooked: true };

    setMealData((prev) => ({ ...prev, [cellKey]: updatedItems }));
    setCookedStatus((prev) => ({ ...prev, [menuItem.id]: true }));

    const ingredientsToDeduct = getMenuItemIngredients(cellKey, menuItem);
    if (ingredientsToDeduct.length > 0) {
      deductFromPantry(ingredientsToDeduct);
    }

    closePantryDialog();
  };

  const handleCancelCooked = () => {
    if (!showPantryDialog) return;
    const { cellKey, index } = showPantryDialog;
    const items = mealData[cellKey];
    if (!items || !items[index]) return;

    const menuItem = items[index];
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], cooked: true };

    setMealData((prev) => ({ ...prev, [cellKey]: updatedItems }));
    setCookedStatus((prev) => ({ ...prev, [menuItem.id]: true }));

    closePantryDialog();
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
    const storedMenu = localStorage.getItem(getMenuStorageKey());
    if (storedMenu) {
      try {
        const parsedMenu = JSON.parse(storedMenu);
        const converted: Record<string, MenuItem[]> = {};
        for (const [key, value] of Object.entries(parsedMenu)) {
          const items = ensureArray(value as MenuItem | MenuItem[] | undefined);
          converted[key] = items.map((it) => ensureTextItemCompatibility(it));
        }
        setMealData(converted);
      } catch (e) {
        console.error("Failed to load menu data:", e);
        setMealData({});
      }
    } else {
      setMealData({});
    }

    const storedCounts = localStorage.getItem(getCellPeopleCountKey());
    if (storedCounts) {
      try {
        setCellPeopleCount(JSON.parse(storedCounts));
      } catch (e) {
        console.error("Failed to load cell people count:", e);
        setCellPeopleCount({});
      }
    } else {
      setCellPeopleCount({});
    }

    const storedCookedStatus = localStorage.getItem(getCookedStatusKey());
    if (storedCookedStatus) {
      try {
        setCookedStatus(JSON.parse(storedCookedStatus));
      } catch (e) {
        console.error("Failed to load cooked status:", e);
        setCookedStatus({});
      }
    } else {
      setCookedStatus({});
    }

    const storedActiveProducts = localStorage.getItem(getActiveProductsKey());
    if (storedActiveProducts) {
      try {
        const parsed = JSON.parse(storedActiveProducts);
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map((item) => item as Partial<ActivePeriodProduct>)
            .filter((item) => typeof item.name === "string" && item.name.trim().length > 0)
            .map((item) => ({
              id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
              name: String(item.name).trim(),
              scope:
                item.scope === "today" || item.scope === "this_week" || item.scope === "until_date"
                  ? item.scope
                  : "this_week",
              untilDate: typeof item.untilDate === "string" && item.untilDate ? item.untilDate : periodEnd,
              prefer: item.prefer !== false,
            }));
          setActiveProducts(normalized);
        } else {
          setActiveProducts([]);
        }
      } catch (e) {
        console.error("Failed to load active products:", e);
        setActiveProducts([]);
      }
    } else {
      setActiveProducts([]);
    }

    setHasLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(getMenuStorageKey(), JSON.stringify(mealData));
  }, [mealData, hasLoaded, rangeKey]);

  useEffect(() => {
    if (!hasLoaded || typeof window === "undefined") return;
    if (forceFirstFromQuery) {
      localStorage.removeItem(MENU_FIRST_VISIT_ONBOARDING_KEY);
      setForcedOnboardingFlow(true);
      setShowFirstVisitOnboarding(true);
      return;
    }

    const isDismissed = localStorage.getItem(MENU_FIRST_VISIT_ONBOARDING_KEY) === "1";
    if (menuMode === "mine" && recipes.length === 0 && !isDismissed) {
      setShowFirstVisitOnboarding(true);
    }
  }, [forceFirstFromQuery, hasLoaded, menuMode, recipes.length, router]);

  useEffect(() => {
    if (forceFirstFromQuery) return;
    if (recipes.length > 0 && !forcedOnboardingFlow) {
      setShowCalendarInlineHint(false);
      setShowFirstVisitOnboarding(false);
    }
  }, [forceFirstFromQuery, forcedOnboardingFlow, recipes.length]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(getCellPeopleCountKey(), JSON.stringify(cellPeopleCount));
  }, [cellPeopleCount, hasLoaded, rangeKey]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(getCookedStatusKey(), JSON.stringify(cookedStatus));
  }, [cookedStatus, hasLoaded, rangeKey]);

  useEffect(() => {
    if (!hasLoaded) return;
    localStorage.setItem(getActiveProductsKey(), JSON.stringify(activeProducts));
  }, [activeProducts, hasLoaded, rangeKey]);

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
    if (!selectedTitle) selectedTitle = "рецепт";

    const todayKey = formatDate(new Date());
    const tomorrowKey = formatDate(addDays(new Date(), 1));
    const selectedDay = dayKeys.includes(tomorrowKey)
      ? tomorrowKey
      : dayKeys.includes(todayKey)
        ? todayKey
        : dayKeys[0];
    if (!selectedDay) return;

    const preferredMeal = resolvePreferredMealForRecipe(selectedRecipe, mealFromQuery);
    const targetCellKey = getCellKey(selectedDay, preferredMeal);
    const selectedDate = parseDateSafe(selectedDay);
    const weekdayLabel = getWeekdayLong(selectedDay) || getWeekdayLabel(selectedDay);
    const dayLabelWithDate = selectedDate ? `${weekdayLabel}, ${formatDisplayDate(selectedDate)}` : weekdayLabel;

    closeAddEditDialog();
    setShowMenuAddedNotice(false);
    setMenuAddedHasIngredients(false);

    setPendingRecipeForMenu(recipeId);
    setQuickRecipeConfirm({
      recipeId,
      recipeTitle: selectedTitle,
      cellKey: targetCellKey,
      dayLabel: dayLabelWithDate,
      mealLabel: preferredMeal.toLocaleLowerCase("ru-RU"),
    });

    router.replace("/menu");
  }, [dayKeys, hasLoaded, recipes, router, searchParams]);

  const generateShoppingList = () => {
    const dishNames = Object.values(mealData)
      .map((item) => getDisplayText(item))
      .filter((name) => name.trim() !== "");

    persistMenuSnapshot(mealData);
    sessionStorage.setItem("menuDishes", JSON.stringify(dishNames));
    sessionStorage.setItem("cellPeopleCount", JSON.stringify(cellPeopleCount));
    router.push("/shopping-list");
  };

  const handleAddItemClick = (key: string) => {
    closeDropdownMenu();

    setAddingItemCell(key);
    setEditingItem(null);

    setNewItemType("recipe");
    setNewItemText("");
    setNewItemRecipeId("");
    setNewItemIncludeInShopping(true);
    setNewItemIngredients([{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);

    const count = getEffectivePeopleCount(key);
    setNewItemPeopleCount(count);
    setPeopleInput(count.toString());

    setRecipeCategoryFilter("Все");
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
    setNewItemIngredients([{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);

    const count = getEffectivePeopleCount(targetCellKey);
    setNewItemPeopleCount(count);
    setPeopleInput(count.toString());
    setRecipeCategoryFilter("Все");
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
        ?.filter((ingredient) => ingredient.name.trim() && (ingredient.unit === "по вкусу" || ingredient.amount > 0))
        .map((ingredient) => ({
          ...ingredient,
          amount: ingredient.unit === "по вкусу" ? 0 : ingredient.amount * scale,
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
              ? newItemIngredients.filter((ing) => ing.name.trim() && (ing.unit === "по вкусу" || ing.amount > 0))
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

  const handleDeleteItem = (cellKey: string, itemIndex: number) => {
    if (confirm("Вы уверены, что хотите очистить меню периода?")) {
      handleRemoveItem(cellKey, itemIndex);
    }
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
      setNewItemIngredients(item.ingredients || [{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
    } else {
      setNewItemType("text");
      setNewItemText(item.value || "");
      setNewItemRecipeId("");
      setNewItemIncludeInShopping(item.includeInShopping ?? true);
      setNewItemIngredients(item.ingredients || [{ id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
    }

    const count = getEffectivePeopleCount(cellKey);
    setNewItemPeopleCount(count);
    setPeopleInput(count.toString());
    setRecipeCategoryFilter("Все");
  };

  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string | number) => {
    setNewItemIngredients((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const addIngredientField = () => {
    setNewItemIngredients((prev) => [...prev, { id: crypto.randomUUID(), name: "", amount: 0, unit: DEFAULT_UNIT }]);
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
    if (!movingItem || !moveTargetDay || !moveTargetMeal) return;

    const fromKey = movingItem.cellKey;
    const fromIndex = movingItem.index;
    const toKey = getCellKey(moveTargetDay, moveTargetMeal);

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

  const clearWeek = () => {
    if (confirm("Вы уверены, что хотите очистить день из текущего меню?")) {
      setMealData({});
      localStorage.removeItem(getMenuStorageKey());
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
        target.closest(".move-dialog") ||
        target.closest(".pantry-dialog");

      if (dialogMouseDownRef.current && !clickedInside) {
        dialogMouseDownRef.current = false;
        return;
      }

      dialogMouseDownRef.current = false;

      if (clickedInside) return;

      if (openMoreMenu) closeDropdownMenu();
      if (movingItem) closeMoveDialog();
      if (addingItemCell) closeAddEditDialog();
      if (showPantryDialog) closePantryDialog();
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      resetAllModalStates();
    };

    if (openMoreMenu || movingItem || addingItemCell || showPantryDialog) {
      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("click", handleOutsideClick, false);
      document.addEventListener("keydown", handleEscapeKey, true);
    }

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", handleOutsideClick, false);
      document.removeEventListener("keydown", handleEscapeKey, true);
    };
  }, [openMoreMenu, movingItem, addingItemCell, showPantryDialog]);

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
          Редактировать
        </button>
        <button type="button" onClick={() => handleMoveClick(cellKey, index)} className="menu-grid__item-menu-move">
          Переместить
        </button>
        <button type="button" onClick={() => handleDeleteItem(cellKey, index)} className="menu-grid__item-menu-delete">
          Удалить
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
          <h3>Перемещение блюда</h3>

          <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>
            Выбранный элемент:{" "}
            <strong>
              {item?.type === "recipe" && item.recipeId
                ? recipes.find((r) => r.id === item.recipeId)?.title || ""
                : item?.value || ""}
            </strong>
          </div>

          <div className="move-dialog-row">
            <label>День:</label>
            <select value={moveTargetDay} onChange={(e) => setMoveTargetDay(e.target.value)} className="move-dialog-select">
              <option value="">Выберите...</option>
              {dayEntries.map((dayEntry) => (
                <option key={dayEntry.dateKey} value={dayEntry.dateKey}>
                  {dayEntry.dayLabel} {dayEntry.displayDate}
                </option>
              ))}
            </select>
          </div>

          <div className="move-dialog-row">
            <label>Прием:</label>
            <select value={moveTargetMeal} onChange={(e) => setMoveTargetMeal(e.target.value)} className="move-dialog-select">
              <option value="">Выберите...</option>
              {meals.map((meal) => (
                <option key={meal} value={meal}>
                  {meal}
                </option>
              ))}
            </select>
          </div>

          <div className="move-dialog-actions">
            <button type="button" onClick={handleMoveConfirm} disabled={!moveTargetDay || !moveTargetMeal} className="move-dialog-confirm">
              Переместить
            </button>
            <button type="button" onClick={closeMoveDialog} className="move-dialog-cancel">
              Отмена
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  };

  const PantryDialog = () => {
    if (!showPantryDialog) return null;

    const { cellKey, index } = showPantryDialog;
    const items = mealData[cellKey];
    const menuItem = items?.[index];
    const hasIngredients = !!(menuItem?.ingredients && menuItem.ingredients.length > 0);

    return createPortal(
      <div
        className="menu-dialog-overlay"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0, 0, 0, 0.5)",
          zIndex: 10000,
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closePantryDialog(); // закрытие
        }}
      >
        <div
          className="pantry-dialog"
          style={{
            position: "relative",
            zIndex: 10001,
            backgroundColor: "#fff",
            border: "1px solid #ddd",
            borderRadius: "8px",
            padding: "20px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
            minWidth: "400px",
            maxWidth: "90vw",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 style={{ margin: "0 0 16px 0", color: "#333" }}>Отметить приготовленным и списать продукты?</h3>

          {hasIngredients ? (
            <div style={{ marginBottom: "16px" }}>
              <p style={{ margin: "0 0 8px 0", color: "#666" }}>Ингредиенты для списания:</p>
              <div
                style={{
                  backgroundColor: "#f8f9fa",
                  padding: "12px",
                  borderRadius: "4px",
                  border: "1px solid #e9ecef",
                }}
              >
                {menuItem!.ingredients!.map((ing, idx) => (
                  <div key={idx} style={{ color: "#495057", fontSize: "14px" }}>
                    {formatIngredient(ing)}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p style={{ margin: "0 0 16px 0", color: "#666" }}>У этого блюда нет ингредиентов для списания.</p>
          )}

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handleCancelCooked}
              style={{
                background: "#6c757d",
                color: "white",
                border: "none",
                padding: "8px 16px",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Нет
            </button>
            <button
              type="button"
              onClick={handleConfirmCooked}
              style={{
                background: "#28a745",
                color: "white",
                border: "none",
                padding: "8px 16px",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Да
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  };

  return (
    <>
      {showFirstVisitOnboarding && (
        <div className="menu-first-onboarding" role="dialog" aria-modal="true" aria-label="Первый вход в календарь">
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
            <h2 className="menu-first-onboarding__title">Добавим первый рецепт</h2>
            <p className="menu-first-onboarding__text">
              Чтобы составить меню, добавьте один рецепт.
            </p>
            <div className="menu-first-onboarding__actions">
              <button type="button" className="btn btn-primary" onClick={handleOnboardingAddFirstRecipe}>
                Добавить первый рецепт
              </button>
              <button type="button" className="menu-first-onboarding__skip" onClick={handleOnboardingTryWithoutRecipes}>
                Можно попробовать без рецептов
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
          <p style={{ margin: "0", fontWeight: 700 }}>Блюдо добавлено в меню.</p>
          <p className="muted" style={{ margin: "4px 0 10px 0" }}>
            {menuAddedHasIngredients
              ? "Ингредиенты добавлены в список покупок."
              : "Для этого блюда пока нет ингредиентов в списке покупок."}
          </p>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                persistMenuSnapshot(mealData);
                if (typeof window !== "undefined") {
                  window.sessionStorage.setItem(GUEST_REMINDER_PENDING_KEY, "1");
                }
                router.push("/shopping-list");
              }}
            >
              Посмотреть список покупок
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
              Продолжить планирование
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
              ? "Чтобы данные не потерялись, зарегистрируйтесь."
              : "Чтобы сохранить ваши рецепты и меню, создайте аккаунт."}
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
              Создать аккаунт
            </button>
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

      {quickRecipeConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Подтверждение добавления блюда"
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
              Добавить {quickRecipeConfirm.recipeTitle} в {quickRecipeConfirm.dayLabel} ({quickRecipeConfirm.mealLabel})?
            </h3>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button type="button" className="btn btn-primary" onClick={handleQuickRecipeAdd}>
                Добавить
              </button>
              <button type="button" className="btn" onClick={handleQuickRecipeChooseAnotherDay}>
                Выбрать другой день
              </button>
            </div>
          </div>
        </div>
      )}
      <section className="card">
      <div className="menu-header">
        <h1 className="h1">Меню на период</h1>
        <div className="week-navigation">
          <button className="week-nav-btn" onClick={goToPreviousWeek}>
            ← Назад
          </button>
          <span className="week-range">Период: {getRangeDisplay(weekStart, periodEnd)}</span>
          <button className="week-nav-btn" onClick={goToNextWeek}>
            Вперед →
          </button>
        </div>
        <div style={{ marginTop: "12px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>Период:</span>
          <select
            className="input"
            value={periodPreset}
            onChange={(e) => applyPeriodPreset(e.target.value as PeriodPreset)}
            style={{ width: "190px" }}
          >
            <option value="7d">7 дней</option>
            <option value="10d">10 дней</option>
            <option value="14d">14 дней</option>
            <option value="month">Месяц</option>
            <option value="custom">Свой диапазон</option>
          </select>
          {periodPreset === "custom" && (
            <>
              <input
                className="input"
                type="date"
                value={customStartInput}
                onChange={(e) => setCustomStartInput(e.target.value)}
                style={{ width: "170px" }}
              />
              <input
                className="input"
                type="date"
                value={customEndInput}
                onChange={(e) => setCustomEndInput(e.target.value)}
                style={{ width: "170px" }}
              />
              <button type="button" className="btn" onClick={() => applyPeriodPreset("custom")}>
                Применить
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: "14px", padding: "12px" }}>
        <h3 style={{ marginTop: 0, marginBottom: "10px" }}>Активные продукты периода</h3>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
          <div style={{ flex: "1 1 260px", minWidth: "220px" }}>
            <ProductAutocompleteInput
              value={activeProductName}
              onChange={setActiveProductName}
              suggestions={knownProductSuggestions}
              placeholder="Например: лосось, йогурт, курица"
            />
          </div>
          <select
            className="input"
            value={activeProductScope}
            onChange={(e) => setActiveProductScope(e.target.value as ActiveProductScope)}
            style={{ width: "170px" }}
          >
            <option value="today">Сегодня</option>
            <option value="this_week">Эта неделя</option>
            <option value="until_date">До даты</option>
          </select>
          {activeProductScope === "until_date" ? (
            <input
              className="input"
              type="date"
              value={activeProductUntilDate}
              onChange={(e) => setActiveProductUntilDate(e.target.value)}
              style={{ width: "170px" }}
            />
          ) : null}
          <button type="button" className="btn btn-primary" onClick={addActiveProduct}>
            Добавить
          </button>
        </div>
        {activeProducts.length > 0 ? (
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {activeProducts.map((product) => (
              <div
                key={product.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  border: "1px solid var(--border-default)",
                  borderRadius: "999px",
                  padding: "6px 10px",
                  background: "var(--background-primary)",
                }}
              >
                <span style={{ fontSize: "13px" }}>
                  {product.name} до {formatDisplayDate(parseDateSafe(product.untilDate) || new Date())}
                </span>
                <label style={{ display: "inline-flex", gap: "4px", alignItems: "center", fontSize: "12px" }}>
                  <input
                    type="checkbox"
                    checked={product.prefer}
                    onChange={() => toggleActiveProductPriority(product.id)}
                  />
                  В приоритете
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={() => removeActiveProduct(product.id)}
                  style={{ padding: "2px 8px" }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Добавьте продукты, которые хотите использовать чаще в этом периоде.
          </p>
        )}
      </div>

      {showCalendarInlineHint && recipes.length === 0 && (
        <div className="menu-inline-onboarding-hint">
          Подсказка: нажмите <strong>+</strong> в любом дне, чтобы добавить блюдо в меню.
          <button type="button" className="menu-inline-onboarding-hint__close" onClick={() => setShowCalendarInlineHint(false)}>
            Понятно
          </button>
        </div>
      )}

      <div className="menu-board">
        {dayEntries.map((dayEntry) => {
          return (
            <article key={dayEntry.dateKey} className="menu-day-card">
              <header className="menu-day-card__header">
                <span className="menu-day-card__day">{dayEntry.dayLabel}</span>
                <span className="menu-day-card__date">{dayEntry.displayDate}</span>
              </header>

              <div className="menu-day-card__meals">
                {meals.map((meal) => {
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
                          title={`Добавить блюдо (${meal})`}
                        >
                          +
                        </button>
                      </div>

                      <div className="menu-slot__items">
                        {items.length > 0 ? (
                          items.map((menuItem, index) => {
                            const menuKey = `${key}-${index}`;
                            const title =
                              menuItem.type === "recipe" && menuItem.recipeId
                                ? recipes.find((r) => r.id === menuItem.recipeId)?.title || ""
                                : menuItem.value || "";
                            const hasIngredients = getMenuItemIngredients(key, menuItem).length > 0;

                            return (
                              <div key={menuItem.id} className="menu-slot-item">
                                <span className="menu-slot-item__title" title={title}>
                                  {title}
                                </span>

                                <div className="menu-slot-item__icons">
                                  <label className="menu-slot-item__icon-toggle" title="Приготовлено">
                                    <input
                                      type="checkbox"
                                      checked={getDefaultCookedStatus(dayEntry.dateKey, menuItem.id)}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setShowPantryDialog({ cellKey: key, index });
                                        } else {
                                          const updatedItems = [...(mealData[key] || [])];
                                          updatedItems[index] = { ...updatedItems[index], cooked: false };

                                          setMealData((prev) => ({ ...prev, [key]: updatedItems }));
                                          setCookedStatus((prev) => ({ ...prev, [menuItem.id]: false }));
                                        }
                                      }}
                                      className="menu-slot-item__checkbox"
                                    />
                                  </label>

                                  {menuItem.type === "text" && (
                                    <span className="menu-slot-item__icon" title="Без рецепта">
                                      T
                                    </span>
                                  )}

                                  {hasIngredients && (
                                    <span className="menu-slot-item__icon" title="Есть ингредиенты">
                                      I
                                    </span>
                                  )}

                                  <button
                                    className="menu-grid__item-more menu-slot-item__more"
                                    onClick={(e) => handleMoreMenuToggle(e, menuKey, key, index)}
                                    title="Действия"
                                  >
                                    ...
                                  </button>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <button
                            className="menu-slot__empty"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAddItemClick(key);
                            }}
                          >
                            + Добавить блюдо
                          </button>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>

      <DropdownMenu />
      <MoveDialog />

      <AddEditDialog
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

      <PantryDialog />

      <div className="menu-actions">
        <button
          className="menu-actions__generate-btn"
          onClick={generateShoppingList}
          disabled={Object.values(mealData).filter((item) => getDisplayText(item).trim() !== "").length === 0}
        >
          Сформировать список покупок
        </button>

        <button className="menu-actions__clear-btn" onClick={clearWeek} disabled={Object.keys(mealData).length === 0}>
          Очистить период
        </button>
      </div>
      </section>
    </>
  );
}

export default function MenuPage() {
  return (
    <Suspense fallback={<section className="card"><h1 className="h1">Загрузка меню...</h1></section>}>
      <MenuPageContent />
    </Suspense>
  );
}

