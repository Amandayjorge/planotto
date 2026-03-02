const PRODUCT_SUGGESTIONS_KEY = "productSuggestions";

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");
const NON_PRODUCT_WORD_PATTERN =
  /\b(можно|нужно|нельзя|например|или|если|когда|чтобы|потом|затем|сразу|вручную|сервис|временно|недоступен|распознавание|распознать|рецепт|меню|добавить|открыть|удалить|сохранено|шаг|основное|ингредиент|ингредиенты|способ|приготовления|копировать|импорт|фото|камера|очистить|сергей)\b/iu;

export const sanitizeProductSuggestion = (value: string): string | null => {
  let normalized = normalizeName(value);
  if (!normalized) return null;

  normalized = normalized.replace(/^создать новый продукт:\s*/iu, "");
  normalized = normalized.replace(/^например:\s*/iu, "");
  normalized = normalized.split(/[|•;/:,]+/u)[0]?.trim() || "";
  if (!normalized) return null;

  normalized = normalized
    .replace(/\s+до\s+\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/iu, "")
    .replace(/\s+\d{4}-\d{2}-\d{2}$/u, "")
    .trim();

  if (!normalized) return null;
  if (/https?:\/\//iu.test(normalized)) return null;
  if (!/\p{L}/u.test(normalized)) return null;
  if (normalized.length > 48) return null;
  if (/\d/u.test(normalized)) return null;
  if (!/^[\p{L}\s\-]+$/u.test(normalized)) return null;
  if (/\b\p{L}{4,}(ть|ться)\b/iu.test(normalized)) return null;
  if (NON_PRODUCT_WORD_PATTERN.test(normalized)) return null;
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(normalized)) return null;

  const serviceNoisePattern =
    /(schema cache|api-|error|ошибк|не удалось|добавить|список|подтвердите|failed|stack trace|completed|imported|copied|service unavailable|временно недоступен|recipe recognized|распознан|planotto|рецепт|меню|период|открыть|закрыть|найти|удалить|сохранено|шаг|основное|ингредиент|способ|импорт|фото)/iu;
  if (serviceNoisePattern.test(normalized)) return null;

  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length > 3) return null;

  return normalized;
};

export const STARTER_PRODUCT_SUGGESTIONS = [
  "Куриная грудка",
  "Филе курицы",
  "Курица",
  "Говядина",
  "Свинина",
  "Лосось",
  "Яйцо",
  "Молоко",
  "Рис",
  "Макароны",
  "Картофель",
  "Лук",
  "Морковь",
  "Сыр",
  "Chicken breast",
  "Chicken fillet",
  "Ground beef",
  "Pork chops",
  "Salmon fillet",
  "Eggs",
  "Milk",
  "Rice",
  "Pasta",
  "Potato",
  "Onion",
  "Carrot",
  "Cheese",
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
    const normalized = sanitizeProductSuggestion(item);
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
  const customRaw = readCustomSuggestions();
  const customClean = uniqueSuggestions(customRaw).filter(
    (item) => !STARTER_PRODUCT_SET.has(normalizeName(item).toLowerCase())
  );

  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(PRODUCT_SUGGESTIONS_KEY, JSON.stringify(customClean));
    } catch {
      // ignore localStorage write issues
    }
  }

  return uniqueSuggestions([...STARTER_PRODUCT_SUGGESTIONS, ...customClean]).sort((a, b) =>
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
