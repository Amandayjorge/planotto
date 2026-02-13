const PRODUCT_SUGGESTIONS_KEY = "productSuggestions";

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");

const STARTER_PRODUCT_SUGGESTIONS = [
  "Курица",
  "Индейка",
  "Говядина",
  "Свинина",
  "Рыба",
  "Лосось",
  "Тунец",
  "Креветки",
  "Яйца",
  "Молоко",
  "Кефир",
  "Йогурт",
  "Сметана",
  "Творог",
  "Сливки",
  "Сыр",
  "Масло сливочное",
  "Масло оливковое",
  "Масло подсолнечное",
  "Мука",
  "Сахар",
  "Соль",
  "Перец черный",
  "Рис",
  "Гречка",
  "Овсянка",
  "Макароны",
  "Хлеб",
  "Картофель",
  "Лук",
  "Чеснок",
  "Морковь",
  "Свекла",
  "Капуста",
  "Брокколи",
  "Цветная капуста",
  "Кабачок",
  "Баклажан",
  "Помидоры",
  "Огурцы",
  "Перец болгарский",
  "Шампиньоны",
  "Салат",
  "Шпинат",
  "Укроп",
  "Петрушка",
  "Кинза",
  "Бананы",
  "Яблоки",
  "Лимон",
  "Апельсин",
  "Авокадо",
  "Томатная паста",
  "Томаты в собственном соку",
  "Фасоль",
  "Нут",
  "Чечевица",
  "Горох",
  "Соевый соус",
  "Горчица",
  "Майонез",
  "Кетчуп",
  "Мед",
  "Какао",
  "Шоколад",
  "Орехи",
  "Семечки",
  "Разрыхлитель",
  "Дрожжи",
  "Вода",
] as const;

const STARTER_PRODUCT_SET = new Set(
  STARTER_PRODUCT_SUGGESTIONS.map((item) => normalizeName(item).toLowerCase())
);

const uniqueSuggestions = (items: string[]): string[] => {
  const unique = new Map<string, string>();

  items.forEach((item) => {
    const normalized = normalizeName(item);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!unique.has(key)) unique.set(key, normalized);
  });

  return Array.from(unique.values());
};

const readCustomSuggestions = (): string[] => {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(PRODUCT_SUGGESTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

export const loadProductSuggestions = (): string[] => {
  const custom = readCustomSuggestions();
  return uniqueSuggestions([...STARTER_PRODUCT_SUGGESTIONS, ...custom]).sort((a, b) =>
    a.localeCompare(b, "ru", { sensitivity: "base" })
  );
};

export const saveProductSuggestions = (items: string[]) => {
  if (typeof window === "undefined") return;

  const customOnly = uniqueSuggestions(items).filter(
    (item) => !STARTER_PRODUCT_SET.has(normalizeName(item).toLowerCase())
  );

  localStorage.setItem(PRODUCT_SUGGESTIONS_KEY, JSON.stringify(customOnly));
};

export const appendProductSuggestions = (items: string[]) => {
  const existing = readCustomSuggestions();
  saveProductSuggestions([...existing, ...items]);
};
