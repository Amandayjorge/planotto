import path from "path";
import { NextResponse } from "next/server";
import PdfPrinterModule from "pdfmake/js/Printer";

export const runtime = "nodejs";

type PdfDocumentStream = {
  on: (event: "data" | "end" | "error", callback: (...args: unknown[]) => void) => void;
  end: () => void;
};

type PdfPrinterLike = {
  createPdfKitDocument: (docDefinition: Record<string, unknown>) => Promise<PdfDocumentStream>;
};

type PdfPrinterCtor = new (
  fonts: Record<
    string,
    { normal: string; bold: string; italics: string; bolditalics: string }
  >
) => PdfPrinterLike;

type MenuExportPayload = {
  kind: "menu";
  menuTitle: string;
  periodLabel: string;
  fileName?: string;
  days: Array<{
    dayLabel: string;
    dateLabel: string;
    meals: Array<{
      mealName: string;
      dishes: string[];
    }>;
  }>;
};

type MenuWithRecipesExportPayload = {
  kind: "menu_full";
  menuTitle: string;
  periodLabel: string;
  fileName?: string;
  days: Array<{
    dayLabel: string;
    dateLabel: string;
    meals: Array<{
      mealName: string;
      dishes: string[];
    }>;
  }>;
  recipes: Array<{
    title: string;
    servings: number;
    cookingTime?: string;
    ingredients: string[];
    steps: string[];
    usedIn?: string[];
  }>;
};

type RecipeExportPayload = {
  kind: "recipe";
  fileName?: string;
  recipe: {
    title: string;
    servings: number;
    cookingTime?: string;
    ingredients: string[];
    steps: string[];
    usedIn?: string[];
  };
};

type RecipesExportPayload = {
  kind: "recipes";
  fileName?: string;
  coverTitle?: string;
  recipes: Array<{
    title: string;
    servings: number;
    cookingTime?: string;
    ingredients: string[];
    steps: string[];
    usedIn?: string[];
  }>;
};

type PdfExportPayload =
  | MenuExportPayload
  | MenuWithRecipesExportPayload
  | RecipeExportPayload
  | RecipesExportPayload;

const PdfPrinter = PdfPrinterModule as unknown as PdfPrinterCtor;

let printerInstance: PdfPrinterLike | null = null;

const getPdfPrinter = (): PdfPrinterLike => {
  if (printerInstance) return printerInstance;

  const robotoBase = path.join(process.cwd(), "node_modules", "pdfmake", "fonts", "Roboto");
  printerInstance = new PdfPrinter({
    Roboto: {
      normal: path.join(robotoBase, "Roboto-Regular.ttf"),
      bold: path.join(robotoBase, "Roboto-Medium.ttf"),
      italics: path.join(robotoBase, "Roboto-Italic.ttf"),
      bolditalics: path.join(robotoBase, "Roboto-MediumItalic.ttf"),
    },
  });
  return printerInstance;
};

const toBuffer = async (docDefinition: Record<string, unknown>): Promise<Buffer> => {
  const printer = getPdfPrinter();
  const pdfDoc = await printer.createPdfKitDocument(docDefinition);
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on("data", (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
    });
    pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
    pdfDoc.on("error", (error) => reject(error));
    pdfDoc.end();
  });
};

const safeText = (value: unknown, fallback = ""): string => {
  const text = String(value || "").trim();
  return text || fallback;
};

const safeNumber = (value: unknown, fallback = 0): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const safeStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => safeText(item)).filter(Boolean)
    : [];

const sanitizeFileName = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-");
  if (!normalized) return fallback;
  return normalized.toLowerCase().endsWith(".pdf") ? normalized : `${normalized}.pdf`;
};

const getBaseDoc = (content: unknown[]): Record<string, unknown> => ({
  pageSize: "A4",
  pageOrientation: "portrait",
  pageMargins: [42, 54, 42, 42],
  defaultStyle: {
    font: "Roboto",
    fontSize: 11,
    color: "#111111",
  },
  styles: {
    title: { fontSize: 22, bold: true, margin: [0, 0, 0, 8] },
    subtitle: { fontSize: 12, color: "#555555", margin: [0, 0, 0, 12] },
    sectionTitle: { fontSize: 15, bold: true, margin: [0, 10, 0, 6] },
    dayTitle: { fontSize: 13, bold: true, margin: [0, 10, 0, 4] },
    meta: { fontSize: 11, margin: [0, 2, 0, 2] },
    body: { fontSize: 11, margin: [0, 0, 0, 4] },
    smallMuted: { fontSize: 9, color: "#666666" },
    coverTitle: { fontSize: 28, bold: true, alignment: "center", margin: [0, 260, 0, 0] },
  },
  footer: (currentPage: number, pageCount: number) => ({
    columns: [{ text: `Стр. ${currentPage} / ${pageCount}`, alignment: "right" }],
    margin: [42, 0, 42, 16],
    fontSize: 8,
    color: "#666666",
  }),
  content,
});

const toRecipeContentBlock = (
  recipe: {
    title: string;
    servings: number;
    cookingTime?: string;
    ingredients: string[];
    steps: string[];
    usedIn?: string[];
  },
  pageBreakBefore = false
): Record<string, unknown> => ({
  pageBreak: pageBreakBefore ? "before" : undefined,
  stack: [
    { text: safeText(recipe.title, "Recipe"), style: "title" },
    recipe.usedIn && recipe.usedIn.length > 0
      ? { text: `Используется в: ${recipe.usedIn.map((day) => safeText(day)).join(", ")}`, style: "smallMuted" }
      : { text: "", style: "smallMuted", margin: [0, 0, 0, 0] },
    {
      columns: [
        { text: `Порции: ${Math.max(1, safeNumber(recipe.servings, 1))}`, style: "meta" },
        { text: `Время приготовления: ${safeText(recipe.cookingTime, "—")}`, style: "meta", alignment: "right" },
      ],
      margin: [0, 0, 0, 8],
    },
    { text: "Ингредиенты", style: "sectionTitle" },
    recipe.ingredients.length > 0
      ? { ul: recipe.ingredients.map((item) => safeText(item)), margin: [0, 0, 0, 8] }
      : { text: "—", style: "body" },
    { text: "Шаги приготовления", style: "sectionTitle" },
    recipe.steps.length > 0
      ? { ol: recipe.steps.map((item) => safeText(item)), margin: [0, 0, 0, 8] }
      : { text: "—", style: "body" },
  ],
});

const toMenuContentBlocks = (
  payload: Pick<MenuExportPayload, "menuTitle" | "periodLabel" | "days">
): unknown[] => {
  const content: unknown[] = [
    { text: safeText(payload.menuTitle, "Меню"), style: "title" },
    { text: safeText(payload.periodLabel, "—"), style: "subtitle" },
  ];

  payload.days.forEach((day) => {
    content.push({
      text: `${safeText(day.dayLabel, "—")} ${safeText(day.dateLabel)}`.trim(),
      style: "dayTitle",
    });
    day.meals.forEach((meal) => {
      const dishes = safeStringList(meal.dishes);
      content.push({
        columns: [
          { text: `${safeText(meal.mealName, "—")}:`, width: 110, bold: true },
          { text: dishes.length > 0 ? dishes.join(", ") : "—", style: "body", width: "*" },
        ],
        margin: [0, 0, 0, 3],
      });
    });
  });

  return content;
};

const buildMenuPdf = async (payload: MenuExportPayload): Promise<Buffer> => {
  const content = toMenuContentBlocks(payload);
  return await toBuffer(getBaseDoc(content));
};

const buildMenuWithRecipesPdf = async (payload: MenuWithRecipesExportPayload): Promise<Buffer> => {
  const content: unknown[] = toMenuContentBlocks(payload);
  payload.recipes.forEach((recipe) => {
    content.push(toRecipeContentBlock(recipe, true));
  });
  return await toBuffer(getBaseDoc(content));
};

const buildSingleRecipePdf = async (payload: RecipeExportPayload): Promise<Buffer> => {
  const recipe = payload.recipe;
  const content = [toRecipeContentBlock(recipe)];
  return await toBuffer(getBaseDoc(content));
};

const buildRecipesCollectionPdf = async (payload: RecipesExportPayload): Promise<Buffer> => {
  const recipes = payload.recipes;
  const content: unknown[] = [
    { text: safeText(payload.coverTitle, "Сборник рецептов"), style: "coverTitle" },
  ];

  recipes.forEach((recipe) => {
    content.push(toRecipeContentBlock(recipe, true));
  });

  return await toBuffer(getBaseDoc(content));
};

const normalizePayload = (raw: unknown): PdfExportPayload | null => {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = safeText(record.kind);

  if (kind === "menu") {
    const daysRaw = Array.isArray(record.days) ? record.days : [];
    const days = daysRaw.map((day) => {
      const dayRecord = day as Record<string, unknown>;
      const mealsRaw = Array.isArray(dayRecord.meals) ? dayRecord.meals : [];
      return {
        dayLabel: safeText(dayRecord.dayLabel),
        dateLabel: safeText(dayRecord.dateLabel),
        meals: mealsRaw.map((meal) => {
          const mealRecord = meal as Record<string, unknown>;
          return {
            mealName: safeText(mealRecord.mealName),
            dishes: safeStringList(mealRecord.dishes),
          };
        }),
      };
    });
    return {
      kind: "menu",
      menuTitle: safeText(record.menuTitle, "Меню"),
      periodLabel: safeText(record.periodLabel, "—"),
      days,
      fileName: safeText(record.fileName),
    };
  }

  if (kind === "menu_full") {
    const daysRaw = Array.isArray(record.days) ? record.days : [];
    const recipesRaw = Array.isArray(record.recipes) ? record.recipes : [];
    const days = daysRaw.map((day) => {
      const dayRecord = day as Record<string, unknown>;
      const mealsRaw = Array.isArray(dayRecord.meals) ? dayRecord.meals : [];
      return {
        dayLabel: safeText(dayRecord.dayLabel),
        dateLabel: safeText(dayRecord.dateLabel),
        meals: mealsRaw.map((meal) => {
          const mealRecord = meal as Record<string, unknown>;
          return {
            mealName: safeText(mealRecord.mealName),
            dishes: safeStringList(mealRecord.dishes),
          };
        }),
      };
    });
    return {
      kind: "menu_full",
      menuTitle: safeText(record.menuTitle, "Меню"),
      periodLabel: safeText(record.periodLabel, "—"),
      days,
      recipes: recipesRaw.map((recipe) => {
        const recipeRecord = recipe as Record<string, unknown>;
        return {
          title: safeText(recipeRecord.title, "Рецепт"),
          servings: Math.max(1, safeNumber(recipeRecord.servings, 1)),
          cookingTime: safeText(recipeRecord.cookingTime),
          ingredients: safeStringList(recipeRecord.ingredients),
          steps: safeStringList(recipeRecord.steps),
          usedIn: safeStringList(recipeRecord.usedIn),
        };
      }),
      fileName: safeText(record.fileName),
    };
  }

  if (kind === "recipe") {
    const recipeRaw = (record.recipe || {}) as Record<string, unknown>;
    return {
      kind: "recipe",
      fileName: safeText(record.fileName),
      recipe: {
        title: safeText(recipeRaw.title, "Рецепт"),
        servings: Math.max(1, safeNumber(recipeRaw.servings, 1)),
        cookingTime: safeText(recipeRaw.cookingTime),
        ingredients: safeStringList(recipeRaw.ingredients),
        steps: safeStringList(recipeRaw.steps),
        usedIn: safeStringList(recipeRaw.usedIn),
      },
    };
  }

  if (kind === "recipes") {
    const recipesRaw = Array.isArray(record.recipes) ? record.recipes : [];
    return {
      kind: "recipes",
      fileName: safeText(record.fileName),
      coverTitle: safeText(record.coverTitle, "Сборник рецептов"),
      recipes: recipesRaw.map((recipe) => {
        const recipeRecord = recipe as Record<string, unknown>;
        return {
          title: safeText(recipeRecord.title, "Рецепт"),
          servings: Math.max(1, safeNumber(recipeRecord.servings, 1)),
          cookingTime: safeText(recipeRecord.cookingTime),
          ingredients: safeStringList(recipeRecord.ingredients),
          steps: safeStringList(recipeRecord.steps),
          usedIn: safeStringList(recipeRecord.usedIn),
        };
      }),
    };
  }

  return null;
};

const getExportFileName = (payload: PdfExportPayload): string => {
  if (payload.kind === "menu") {
    return sanitizeFileName(payload.fileName || "planotto-menu.pdf", "planotto-menu.pdf");
  }
  if (payload.kind === "menu_full") {
    return sanitizeFileName(payload.fileName || "planotto-menu-full.pdf", "planotto-menu-full.pdf");
  }
  if (payload.kind === "recipe") {
    const title = safeText(payload.recipe.title, "recipe").replace(/\s+/g, "-");
    return sanitizeFileName(payload.fileName || `recipe-${title}.pdf`, "recipe.pdf");
  }
  return sanitizeFileName(payload.fileName || "planotto-recipes.pdf", "planotto-recipes.pdf");
};

export async function POST(request: Request) {
  try {
    const raw = await request.json();
    const payload = normalizePayload(raw);
    if (!payload) {
      return NextResponse.json({ error: "Invalid export payload." }, { status: 400 });
    }

    if (payload.kind === "menu" && payload.days.length === 0) {
      return NextResponse.json({ error: "Menu is empty for export." }, { status: 400 });
    }
    if (payload.kind === "menu_full" && payload.days.length === 0) {
      return NextResponse.json({ error: "Menu is empty for export." }, { status: 400 });
    }
    if (payload.kind === "recipe" && !payload.recipe.title.trim()) {
      return NextResponse.json({ error: "Recipe title is required." }, { status: 400 });
    }
    if (payload.kind === "recipes" && payload.recipes.length === 0) {
      return NextResponse.json({ error: "Select at least one recipe for export." }, { status: 400 });
    }

    let buffer: Buffer;
    if (payload.kind === "menu") {
      buffer = await buildMenuPdf(payload);
    } else if (payload.kind === "menu_full") {
      buffer = await buildMenuWithRecipesPdf(payload);
    } else if (payload.kind === "recipe") {
      buffer = await buildSingleRecipePdf(payload);
    } else {
      buffer = await buildRecipesCollectionPdf(payload);
    }

    const fileName = getExportFileName(payload);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "PDF export failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
