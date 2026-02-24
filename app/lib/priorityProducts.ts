export const PRIORITY_PRODUCTS_KEY = "priorityProducts";
const PRIORITY_PRODUCTS_CHANGED_EVENT = "priority-products-changed";

export type PriorityPeriodMode = "today" | "week" | "days" | "date";

export interface PriorityProduct {
  id: string;
  name: string;
  untilDate: string; // YYYY-MM-DD
  preferOften: boolean;
  note: string;
  periodMode: PriorityPeriodMode;
  createdAt: string;
}

interface AddPriorityProductInput {
  name: string;
  periodMode: PriorityPeriodMode;
  days?: number;
  untilDate?: string;
  preferOften?: boolean;
  note?: string;
}

interface UpdatePriorityProductInput {
  name?: string;
  periodMode?: PriorityPeriodMode;
  days?: number;
  untilDate?: string;
  note?: string;
}

const PRIORITY_NOTE_MAX_LENGTH = 120;

const pad2 = (value: number) => String(value).padStart(2, "0");

export const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const parseDate = (raw: string): Date | null => {
  if (!raw) return null;
  const [y, m, d] = raw.split("-").map((part) => Number(part));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
};

const normalizeName = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
const normalizeNote = (value: string): string => value.trim().slice(0, PRIORITY_NOTE_MAX_LENGTH);

const endOfWeek = (date: Date): Date => {
  const day = date.getDay(); // 0..6 (0 = Sunday)
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  const next = new Date(date);
  next.setDate(next.getDate() + daysUntilSunday);
  return next;
};

export const resolveUntilDate = (
  periodMode: PriorityPeriodMode,
  daysInput: number,
  customUntilDate?: string
): string => {
  const now = new Date();

  if (periodMode === "today") {
    return formatLocalDate(now);
  }

  if (periodMode === "week") {
    return formatLocalDate(endOfWeek(now));
  }

  if (periodMode === "days") {
    const safeDays = Number.isFinite(daysInput) ? Math.max(1, Math.round(daysInput)) : 7;
    const next = new Date(now);
    next.setDate(next.getDate() + safeDays - 1);
    return formatLocalDate(next);
  }

  const parsed = parseDate(customUntilDate || "");
  return parsed ? formatLocalDate(parsed) : formatLocalDate(now);
};

const emitChanged = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PRIORITY_PRODUCTS_CHANGED_EVENT));
};

export const getPriorityProductsChangedEventName = () => PRIORITY_PRODUCTS_CHANGED_EVENT;

export const loadPriorityProducts = (): PriorityProduct[] => {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(PRIORITY_PRODUCTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const rows = parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => item as Partial<PriorityProduct>)
      .map((item) => ({
        id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
        name: typeof item.name === "string" ? item.name.trim() : "",
        untilDate: typeof item.untilDate === "string" ? item.untilDate : formatLocalDate(new Date()),
        preferOften: Boolean(item.preferOften),
        note: typeof item.note === "string" ? normalizeNote(item.note) : "",
        periodMode: (item.periodMode as PriorityPeriodMode) || "date",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      }))
      .filter((item) => item.name.length > 0);

    return rows.sort((a, b) => a.untilDate.localeCompare(b.untilDate));
  } catch {
    return [];
  }
};

export const savePriorityProducts = (items: PriorityProduct[]) => {
  if (typeof window === "undefined") return;
  localStorage.setItem(PRIORITY_PRODUCTS_KEY, JSON.stringify(items));
  emitChanged();
};

export const addPriorityProduct = (input: AddPriorityProductInput): PriorityProduct | null => {
  if (typeof window === "undefined") return null;
  const name = input.name.trim();
  if (!name) return null;

  const next: PriorityProduct = {
    id: crypto.randomUUID(),
    name,
    untilDate: resolveUntilDate(input.periodMode, input.days || 7, input.untilDate),
    preferOften: Boolean(input.preferOften),
    note: normalizeNote(input.note || ""),
    periodMode: input.periodMode,
    createdAt: new Date().toISOString(),
  };

  const current = loadPriorityProducts();
  const key = normalizeName(name);
  const merged = current.filter((item) => normalizeName(item.name) !== key);
  merged.push(next);
  savePriorityProducts(merged);
  return next;
};

export const removePriorityProduct = (id: string) => {
  if (typeof window === "undefined") return;
  const next = loadPriorityProducts().filter((item) => item.id !== id);
  savePriorityProducts(next);
};

export const updatePriorityProduct = (id: string, input: UpdatePriorityProductInput): PriorityProduct | null => {
  if (typeof window === "undefined") return null;
  const current = loadPriorityProducts();
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) return null;

  const existing = current[index];
  const nextName = typeof input.name === "string" ? input.name.trim() : existing.name;
  if (!nextName) return null;

  const nextMode = input.periodMode || existing.periodMode;
  const nextUntilDate = resolveUntilDate(nextMode, input.days || 7, input.untilDate || existing.untilDate);
  const nextNote = typeof input.note === "string" ? normalizeNote(input.note) : existing.note;

  const updated: PriorityProduct = {
    ...existing,
    name: nextName,
    periodMode: nextMode,
    untilDate: nextUntilDate,
    note: nextNote,
    preferOften: false,
  };

  const next = [...current];
  next[index] = updated;
  savePriorityProducts(next);
  return updated;
};

export const isPriorityProductActive = (item: PriorityProduct, now = new Date()): boolean => {
  const today = formatLocalDate(now);
  return item.untilDate >= today;
};

export const getActivePriorityProducts = (now = new Date()): PriorityProduct[] =>
  loadPriorityProducts().filter((item) => isPriorityProductActive(item, now));

export const getActivePriorityNames = (now = new Date()): string[] =>
  getActivePriorityProducts(now).map((item) => item.name);

const normalizedSet = (items: string[]) => new Set(items.map((item) => normalizeName(item)).filter(Boolean));

export const getRecipePriorityMatchCount = (
  recipeIngredientNames: string[],
  activePriorityNames: string[]
): number => {
  if (recipeIngredientNames.length === 0 || activePriorityNames.length === 0) return 0;

  const prioritySet = normalizedSet(activePriorityNames);
  const ingredients = recipeIngredientNames.map((name) => normalizeName(name)).filter(Boolean);
  let count = 0;

  for (const product of prioritySet) {
    if (ingredients.some((ingredient) => ingredient.includes(product) || product.includes(ingredient))) {
      count += 1;
    }
  }

  return count;
};
