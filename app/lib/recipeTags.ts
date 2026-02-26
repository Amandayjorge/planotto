export type RecipeTagLocale = "ru" | "en" | "es";

export type RecipeTagOption = {
  id: string;
  labels: Record<RecipeTagLocale, string>;
  aliases: string[];
};

const normalizeTagText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[.,/()[\]{}%]/g, " ")
    .replace(/\s+/g, " ");

export const RECIPE_TAG_OPTIONS: RecipeTagOption[] = [
  { id: "vegan", labels: { ru: "Веган", en: "Vegan", es: "Vegano" }, aliases: ["веган", "vegano"] },
  { id: "vegetarian", labels: { ru: "Вегетарианский", en: "Vegetarian", es: "Vegetariano" }, aliases: ["вегетарианский", "vegetariano"] },
  { id: "gluten_free", labels: { ru: "Без глютена", en: "Gluten free", es: "Sin gluten" }, aliases: ["без глютена", "sin gluten"] },
  { id: "lactose_free", labels: { ru: "Без лактозы", en: "Lactose free", es: "Sin lactosa" }, aliases: ["без лактозы", "sin lactosa"] },
  { id: "healthy", labels: { ru: "ПП", en: "Healthy", es: "Saludable" }, aliases: ["пп", "healthy", "saludable"] },
  { id: "breakfast", labels: { ru: "Завтрак", en: "Breakfast", es: "Desayuno" }, aliases: ["завтрак", "breakfast", "desayuno"] },
  { id: "lunch", labels: { ru: "Обед", en: "Lunch", es: "Almuerzo" }, aliases: ["обед", "lunch", "almuerzo", "comida"] },
  { id: "dinner", labels: { ru: "Ужин", en: "Dinner", es: "Cena" }, aliases: ["ужин", "dinner", "cena"] },
  { id: "snack", labels: { ru: "Перекус", en: "Snack", es: "Snack" }, aliases: ["перекус", "snack"] },
  { id: "dessert", labels: { ru: "Десерт", en: "Dessert", es: "Postre" }, aliases: ["десерт", "dessert", "postre"] },
  { id: "baking", labels: { ru: "Выпечка", en: "Baking", es: "Horneado" }, aliases: ["выпечка", "baking", "horneado"] },
  { id: "quick", labels: { ru: "Быстро (до 30 минут)", en: "Quick (up to 30 min)", es: "Rapido (hasta 30 min)" }, aliases: ["быстро", "quick", "rapido", "до 30 минут"] },
  { id: "medium", labels: { ru: "Средне", en: "Medium", es: "Medio" }, aliases: ["средне", "medium", "medio"] },
  { id: "long", labels: { ru: "Долго", en: "Long", es: "Largo" }, aliases: ["долго", "long", "largo"] },
  { id: "easy", labels: { ru: "Простой", en: "Easy", es: "Facil" }, aliases: ["простой", "easy", "facil"] },
  { id: "advanced", labels: { ru: "Требует навыков", en: "Advanced", es: "Avanzado" }, aliases: ["требует навыков", "advanced", "avanzado"] },
  { id: "everyday", labels: { ru: "На каждый день", en: "Everyday", es: "Para cada dia" }, aliases: ["на каждый день", "everyday", "cada dia"] },
  { id: "festive", labels: { ru: "Праздничное", en: "Festive", es: "Festivo" }, aliases: ["праздничное", "festive", "festivo"] },
  { id: "kids", labels: { ru: "Детское", en: "Kids", es: "Para ninos" }, aliases: ["детское", "kids", "ninos"] },
  { id: "diet", labels: { ru: "Диетическое", en: "Diet", es: "Dietetico" }, aliases: ["диетическое", "diet", "dietetico"] },
  { id: "freezer_friendly", labels: { ru: "Подходит для заморозки", en: "Freezer friendly", es: "Apto para congelar" }, aliases: ["заморозки", "freezer", "congelar"] },
  { id: "make_ahead", labels: { ru: "Можно приготовить заранее", en: "Make ahead", es: "Preparar con antelacion" }, aliases: ["заранее", "make ahead", "antelacion"] },
  { id: "next_day", labels: { ru: "Хорошо на завтра", en: "Good for next day", es: "Bueno para el dia siguiente" }, aliases: ["на завтра", "next day", "dia siguiente"] },
  { id: "oven", labels: { ru: "Духовка", en: "Oven", es: "Horno" }, aliases: ["духовка", "oven", "horno"] },
  { id: "pan", labels: { ru: "Сковорода", en: "Pan", es: "Sarten" }, aliases: ["сковорода", "pan", "sarten"] },
  { id: "no_bake", labels: { ru: "Без выпечки", en: "No bake", es: "Sin horno" }, aliases: ["без выпечки", "no bake", "sin horno"] },
  { id: "multicooker", labels: { ru: "Мультиварка", en: "Multicooker", es: "Multicooker" }, aliases: ["мультиварка", "multicooker"] },
  { id: "soup", labels: { ru: "Суп", en: "Soup", es: "Sopa" }, aliases: ["суп", "soup", "sopa"] },
  { id: "side_dish", labels: { ru: "Гарнир", en: "Side dish", es: "Guarnicion" }, aliases: ["гарнир", "side dish", "guarnicion"] },
];

const byId = new Map<string, RecipeTagOption>(RECIPE_TAG_OPTIONS.map((item) => [item.id, item]));
const byAlias = new Map<string, string>();

RECIPE_TAG_OPTIONS.forEach((option) => {
  const normalizedId = normalizeTagText(option.id);
  if (normalizedId) byAlias.set(normalizedId, option.id);

  (["ru", "en", "es"] as const).forEach((locale) => {
    const normalizedLabel = normalizeTagText(option.labels[locale]);
    if (normalizedLabel) byAlias.set(normalizedLabel, option.id);
  });

  option.aliases.forEach((alias) => {
    const normalizedAlias = normalizeTagText(alias);
    if (normalizedAlias) byAlias.set(normalizedAlias, option.id);
  });
});

export const RECIPE_TAGS = RECIPE_TAG_OPTIONS.map((item) => item.id) as readonly string[];

export const normalizeRecipeTagId = (value: string): string | null => {
  const normalized = normalizeTagText(value || "");
  if (!normalized) return null;
  return byAlias.get(normalized) || null;
};

export const normalizeRecipeTags = (values: string[]): string[] => {
  const unique = new Set<string>();
  values.forEach((value) => {
    const id = normalizeRecipeTagId(value);
    if (id) unique.add(id);
  });
  return Array.from(unique);
};

export const localizeRecipeTag = (value: string, locale: RecipeTagLocale): string => {
  const id = normalizeRecipeTagId(value);
  if (!id) return String(value || "").trim();
  return byId.get(id)?.labels[locale] || byId.get(id)?.labels.ru || id;
};
