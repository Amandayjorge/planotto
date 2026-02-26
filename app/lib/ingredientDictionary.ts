export type IngredientLocale = "ru" | "en" | "es";
export type IngredientCategoryId =
  | "vegetables"
  | "fruits"
  | "protein"
  | "dairy"
  | "grocery"
  | "bakery"
  | "drinks"
  | "other";

export interface IngredientCategoryDictionaryEntry {
  id: IngredientCategoryId;
  names: Record<IngredientLocale, string>;
}

export interface IngredientDictionaryEntry {
  id: string;
  categoryId: IngredientCategoryId;
  names: Record<IngredientLocale, string>;
  aliases?: Partial<Record<IngredientLocale, string[]>>;
}

const normalizeIngredientText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[.,/()[\]{}%]/g, " ")
    .replace(/\s+/g, " ");

const CATEGORY_ENTRIES: IngredientCategoryDictionaryEntry[] = [
  { id: "vegetables", names: { ru: "Овощи", en: "Vegetables", es: "Verduras" } },
  { id: "fruits", names: { ru: "Фрукты", en: "Fruits", es: "Frutas" } },
  { id: "protein", names: { ru: "Белок", en: "Protein", es: "Proteína" } },
  { id: "dairy", names: { ru: "Молочное", en: "Dairy", es: "Lácteos" } },
  { id: "grocery", names: { ru: "Бакалея", en: "Grocery", es: "Despensa seca" } },
  { id: "bakery", names: { ru: "Выпечка", en: "Bakery", es: "Panadería" } },
  { id: "drinks", names: { ru: "Напитки", en: "Drinks", es: "Bebidas" } },
  { id: "other", names: { ru: "Прочее", en: "Other", es: "Otros" } },
];

const ENTRIES: IngredientDictionaryEntry[] = [
  { id: "milk", categoryId: "dairy", names: { ru: "Молоко", en: "Milk", es: "Leche" } },
  { id: "cream", categoryId: "dairy", names: { ru: "Сливки", en: "Cream", es: "Nata" } },
  { id: "cottage_cheese", categoryId: "dairy", names: { ru: "Творог", en: "Cottage cheese", es: "Requeson" } },
  { id: "yogurt", categoryId: "dairy", names: { ru: "Йогурт", en: "Yogurt", es: "Yogur" } },
  { id: "cheese", categoryId: "dairy", names: { ru: "Сыр", en: "Cheese", es: "Queso" } },
  { id: "butter", categoryId: "dairy", names: { ru: "Сливочное масло", en: "Butter", es: "Mantequilla" } },
  { id: "egg", categoryId: "protein", names: { ru: "Яйцо", en: "Egg", es: "Huevo" } },
  { id: "chicken_fillet", categoryId: "protein", names: { ru: "Куриное филе", en: "Chicken fillet", es: "Pechuga de pollo" } },
  { id: "beef", categoryId: "protein", names: { ru: "Говядина", en: "Beef", es: "Ternera" } },
  { id: "salmon", categoryId: "protein", names: { ru: "Лосось", en: "Salmon", es: "Salmon" } },
  { id: "tuna_canned", categoryId: "protein", names: { ru: "Тунец консервированный", en: "Canned tuna", es: "Atun en lata" } },
  { id: "rice", categoryId: "grocery", names: { ru: "Рис", en: "Rice", es: "Arroz" } },
  { id: "oats", categoryId: "grocery", names: { ru: "Овсяные хлопья", en: "Oats", es: "Avena" } },
  { id: "pasta", categoryId: "grocery", names: { ru: "Паста", en: "Pasta", es: "Pasta" } },
  { id: "flour", categoryId: "grocery", names: { ru: "Мука", en: "Flour", es: "Harina" } },
  { id: "sugar", categoryId: "grocery", names: { ru: "Сахар", en: "Sugar", es: "Azucar" } },
  { id: "salt", categoryId: "grocery", names: { ru: "Соль", en: "Salt", es: "Sal" } },
  { id: "olive_oil", categoryId: "grocery", names: { ru: "Оливковое масло", en: "Olive oil", es: "Aceite de oliva" } },
  { id: "vegetable_oil", categoryId: "grocery", names: { ru: "Растительное масло", en: "Vegetable oil", es: "Aceite vegetal" } },
  { id: "bread", categoryId: "bakery", names: { ru: "Хлеб", en: "Bread", es: "Pan" } },
  { id: "potato", categoryId: "vegetables", names: { ru: "Картофель", en: "Potato", es: "Patata" } },
  { id: "tomato", categoryId: "vegetables", names: { ru: "Помидор", en: "Tomato", es: "Tomate" } },
  { id: "cucumber", categoryId: "vegetables", names: { ru: "Огурец", en: "Cucumber", es: "Pepino" } },
  { id: "bell_pepper", categoryId: "vegetables", names: { ru: "Болгарский перец", en: "Bell pepper", es: "Pimiento" } },
  { id: "onion", categoryId: "vegetables", names: { ru: "Лук", en: "Onion", es: "Cebolla" } },
  { id: "garlic", categoryId: "vegetables", names: { ru: "Чеснок", en: "Garlic", es: "Ajo" } },
  { id: "carrot", categoryId: "vegetables", names: { ru: "Морковь", en: "Carrot", es: "Zanahoria" } },
  { id: "apple", categoryId: "fruits", names: { ru: "Яблоко", en: "Apple", es: "Manzana" } },
  { id: "banana", categoryId: "fruits", names: { ru: "Банан", en: "Banana", es: "Platano" } },
  { id: "water", categoryId: "drinks", names: { ru: "Вода", en: "Water", es: "Agua" } },
];

const categoryById = new Map<IngredientCategoryId, IngredientCategoryDictionaryEntry>(
  CATEGORY_ENTRIES.map((item) => [item.id, item])
);
const byId = new Map<string, IngredientDictionaryEntry>(ENTRIES.map((item) => [item.id, item]));

const indexByLocale: Record<IngredientLocale, Map<string, string>> = {
  ru: new Map<string, string>(),
  en: new Map<string, string>(),
  es: new Map<string, string>(),
};

const addLocalizedIndex = (locale: IngredientLocale, value: string, id: string) => {
  const normalized = normalizeIngredientText(value);
  if (!normalized) return;
  if (!indexByLocale[locale].has(normalized)) {
    indexByLocale[locale].set(normalized, id);
  }
};

ENTRIES.forEach((entry) => {
  (["ru", "en", "es"] as const).forEach((locale) => {
    addLocalizedIndex(locale, entry.names[locale], entry.id);
    (entry.aliases?.[locale] || []).forEach((alias) => addLocalizedIndex(locale, alias, entry.id));
  });
});

export const listIngredientDictionary = (): IngredientDictionaryEntry[] => [...ENTRIES];
export const listIngredientCategories = (): IngredientCategoryDictionaryEntry[] => [...CATEGORY_ENTRIES];

export const getIngredientNameById = (
  ingredientId: string,
  locale: IngredientLocale,
  fallbackName = ""
): string => {
  const found = byId.get(String(ingredientId || "").trim());
  if (!found) return fallbackName;
  return found.names[locale] || found.names.ru || fallbackName;
};

export const getIngredientCategoryIdByIngredientId = (
  ingredientId: string,
  fallbackCategoryId: IngredientCategoryId = "other"
): IngredientCategoryId => {
  const found = byId.get(String(ingredientId || "").trim());
  return found?.categoryId || fallbackCategoryId;
};

export const getIngredientCategoryNameById = (
  categoryId: string,
  locale: IngredientLocale,
  fallbackName = ""
): string => {
  const normalizedId = String(categoryId || "").trim() as IngredientCategoryId;
  const found = categoryById.get(normalizedId);
  if (!found) return fallbackName;
  return found.names[locale] || found.names.ru || fallbackName;
};

export const findIngredientIdByName = (
  name: string,
  locale: IngredientLocale = "ru"
): string | null => {
  const normalized = normalizeIngredientText(name);
  if (!normalized) return null;

  const direct = indexByLocale[locale].get(normalized);
  if (direct) return direct;

  // Fallback lookup in all locales for imported recipes.
  const fallback =
    indexByLocale.ru.get(normalized) ||
    indexByLocale.en.get(normalized) ||
    indexByLocale.es.get(normalized);

  return fallback || null;
};
