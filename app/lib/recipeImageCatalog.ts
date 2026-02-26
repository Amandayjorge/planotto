type RecipeImageCandidate = {
  id?: string | null;
  title?: string | null;
  image?: string | null;
  type?: string | null;
  isTemplate?: boolean | null;
};

type TemplateRecipeImageEntry = {
  id: string;
  image: string;
  titles: string[];
};

const normalizeRecipeTitle = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const LEGACY_TEMPLATE_IMAGE_URLS = new Set<string>([
  "/recipes/templates/omelet-vegetables.jpg",
  "/recipes/templates/oatmeal-fruits.jpg",
  "/recipes/templates/chicken-rice.jpg",
  "/recipes/templates/lentil-soup.jpg",
  "/recipes/templates/lentil-soup-v2.jpg",
  "/recipes/templates/baked-fish-potatoes.jpg",
  "/recipes/templates/pasta-tomato.jpg",
  "/recipes/templates/tuna-salad.jpg",
  "/recipes/templates/oladi-kefir.jpg",
]);

const TEMPLATE_RECIPE_IMAGE_ENTRIES: TemplateRecipeImageEntry[] = [
  {
    id: "seed-omelet-vegetables",
    image: "/recipes/templates/omelet-vegetables.jpg",
    titles: ["Омлет с овощами", "Vegetable omelet", "Tortilla con verduras"],
  },
  {
    id: "seed-oatmeal-fruits",
    image: "/recipes/templates/oatmeal-fruits.jpg",
    titles: ["Овсяная каша с фруктами", "Oatmeal with fruit", "Avena con fruta"],
  },
  {
    id: "seed-chicken-rice",
    image: "/recipes/templates/chicken-rice.jpg",
    titles: ["Курица с рисом", "Chicken with rice", "Pollo con arroz"],
  },
  {
    id: "seed-baked-fish-potatoes",
    image: "/recipes/templates/baked-fish-potatoes.jpg",
    titles: ["Запеченная рыба с картофелем", "Baked fish with potatoes", "Pescado al horno con patatas"],
  },
  {
    id: "seed-pasta-tomato",
    image: "/recipes/templates/pasta-tomato.jpg",
    titles: ["Паста с томатным соусом", "Pasta with tomato sauce", "Pasta con salsa de tomate"],
  },
  {
    id: "seed-tuna-salad",
    image: "/recipes/templates/tuna-salad.jpg",
    titles: ["Салат с тунцом", "Tuna salad", "Ensalada con atun"],
  },
  {
    id: "seed-oladi-kefir",
    image: "/recipes/templates/oladi-kefir.jpg",
    titles: ["Оладьи на кефире", "Kefir pancakes", "Tortitas de kefir"],
  },
  {
    id: "seed-greek-yogurt-granola",
    image: "https://loremflickr.com/1200/900/yogurt,granola,berries,breakfast?lock=5101",
    titles: ["Йогурт с гранолой", "Yogurt with granola", "Yogur con granola"],
  },
  {
    id: "seed-buckwheat-mushrooms",
    image: "https://loremflickr.com/1200/900/buckwheat,mushrooms,food?lock=5102",
    titles: ["Гречка с грибами", "Buckwheat with mushrooms", "Trigo sarraceno con champinones"],
  },
  {
    id: "seed-mashed-potatoes",
    image: "https://loremflickr.com/1200/900/mashed,potatoes,food?lock=5103",
    titles: ["Картофельное пюре", "Mashed potatoes", "Pure de patatas"],
  },
  {
    id: "seed-vegetable-soup",
    image: "https://loremflickr.com/1200/900/vegetable,soup,bowl?lock=5104",
    titles: ["Овощной суп", "Vegetable soup", "Sopa de verduras"],
  },
  {
    id: "seed-fried-rice-egg",
    image: "https://loremflickr.com/1200/900/fried,rice,egg,food?lock=5105",
    titles: ["Жареный рис с яйцом", "Fried rice with egg", "Arroz frito con huevo"],
  },
  {
    id: "seed-turkey-sandwich",
    image: "https://loremflickr.com/1200/900/turkey,sandwich,food?lock=5106",
    titles: ["Сэндвич с индейкой", "Turkey sandwich", "Sandwich de pavo"],
  },
  {
    id: "seed-cottage-cheese-berries",
    image: "https://loremflickr.com/1200/900/cottage,cheese,berries,breakfast?lock=5107",
    titles: ["Творог с ягодами", "Cottage cheese with berries", "Requeson con frutos rojos"],
  },
  {
    id: "seed-roasted-vegetables",
    image: "https://loremflickr.com/1200/900/roasted,vegetables,food?lock=5108",
    titles: ["Запеченные овощи", "Roasted vegetables", "Verduras al horno"],
  },
  {
    id: "seed-lentil-soup",
    image: "/recipes/templates/lentil-soup-v2.jpg",
    titles: ["Суп из чечевицы", "Lentil soup", "Sopa de lentejas"],
  },
  {
    id: "seed-chicken-noodle-soup",
    image: "https://loremflickr.com/1200/900/chicken,noodle,soup?lock=5109",
    titles: ["Куриный суп с лапшой", "Chicken noodle soup", "Sopa de pollo con fideos"],
  },
  {
    id: "seed-rice-vegetables",
    image: "https://loremflickr.com/1200/900/rice,vegetables,food?lock=5110",
    titles: ["Рис с овощами", "Rice with vegetables", "Arroz con verduras"],
  },
  {
    id: "seed-crepes-milk",
    image: "https://loremflickr.com/1200/900/crepes,breakfast,food?lock=5111",
    titles: ["Блины на молоке", "Milk crepes", "Crepes con leche"],
  },
  {
    id: "seed-tuna-pasta-creamy",
    image: "https://loremflickr.com/1200/900/tuna,pasta,food?lock=5112",
    titles: ["Паста с тунцом", "Pasta with tuna", "Pasta con atun"],
  },
];

const IMAGE_BY_ID = new Map<string, string>(
  TEMPLATE_RECIPE_IMAGE_ENTRIES.map((entry) => [entry.id, entry.image])
);

const IMAGE_BY_TITLE = new Map<string, string>();
TEMPLATE_RECIPE_IMAGE_ENTRIES.forEach((entry) => {
  entry.titles.forEach((title) => {
    const key = normalizeRecipeTitle(title);
    if (key && !IMAGE_BY_TITLE.has(key)) IMAGE_BY_TITLE.set(key, entry.image);
  });
});

export const isLegacyTemplateImageUrl = (value: string): boolean =>
  LEGACY_TEMPLATE_IMAGE_URLS.has(value.trim());

export const getTemplateRecipeImageById = (recipeId: string): string | null => {
  const key = String(recipeId || "").trim();
  return IMAGE_BY_ID.get(key) || null;
};

export const getTemplateRecipeImageByTitle = (title: string): string | null => {
  const key = normalizeRecipeTitle(title || "");
  if (!key) return null;
  return IMAGE_BY_TITLE.get(key) || null;
};

export const resolveRecipeImageForCard = (recipe: RecipeImageCandidate): string => {
  const mapped =
    getTemplateRecipeImageById(String(recipe.id || "")) ||
    getTemplateRecipeImageByTitle(String(recipe.title || ""));
  const direct = String(recipe.image || "").trim();

  if (!mapped) return direct;

  if (recipe.isTemplate === true || recipe.type === "template") {
    return mapped;
  }

  if (!direct) return mapped;
  if (isLegacyTemplateImageUrl(direct)) return mapped;
  return direct;
};
