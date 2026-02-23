const PRODUCT_SUGGESTIONS_KEY = "productSuggestions";

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");

const extractSuggestionName = (value: string): string | null => {
  let normalized = normalizeName(value);
  if (!normalized) return null;

  normalized = normalized.replace(/^создать новый продукт:\s*/iu, "");
  normalized = normalized.split(/[|•;]/u)[0]?.trim() || "";
  if (!normalized) return null;

  normalized = normalized
    .replace(/\s+до\s+\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/iu, "")
    .replace(/\s+\d{4}-\d{2}-\d{2}$/u, "")
    .trim();

  if (!normalized) return null;
  if (/https?:\/\//iu.test(normalized)) return null;
  if (!/\p{L}/u.test(normalized)) return null;
  if (normalized.length > 48) return null;
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(normalized)) return null;
  if (/\b\d{3,}\b/u.test(normalized)) return null;

  const serviceNoisePattern =
    /(schema cache|api-|error|ошибк|не удалось|добавить в мои|список обновлен|подтвердите действие|failed|stack trace|completed|imported|copied|service unavailable|временно недоступен|recipe recognized|распознан|planotto)/iu;
  if (serviceNoisePattern.test(normalized)) return null;

  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length > 6) return null;

  return normalized;
};

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
    const normalized = extractSuggestionName(item);
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
