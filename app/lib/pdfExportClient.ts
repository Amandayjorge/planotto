export interface PdfMenuDayMeal {
  mealName: string;
  dishes: string[];
}

export interface PdfMenuDay {
  dayLabel: string;
  dateLabel: string;
  meals: PdfMenuDayMeal[];
}

export interface PdfRecipePayload {
  title: string;
  servings: number;
  cookingTime?: string;
  ingredients: string[];
  steps: string[];
  usedIn?: string[];
}

export type PdfExportPayload =
  | {
      kind: "menu";
      menuTitle: string;
      periodLabel: string;
      days: PdfMenuDay[];
      fileName?: string;
      uiLanguage?: string;
    }
  | {
      kind: "menu_full";
      menuTitle: string;
      periodLabel: string;
      days: PdfMenuDay[];
      recipes: PdfRecipePayload[];
      fileName?: string;
      uiLanguage?: string;
    }
  | {
      kind: "recipe";
      recipe: PdfRecipePayload;
      fileName?: string;
      uiLanguage?: string;
    }
  | {
      kind: "recipes";
      coverTitle?: string;
      recipes: PdfRecipePayload[];
      fileName?: string;
      uiLanguage?: string;
    };

const parseFileNameFromDisposition = (value: string | null): string | null => {
  if (!value) return null;
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const basicMatch = value.match(/filename=\"?([^\";]+)\"?/i);
  return basicMatch?.[1] || null;
};

const parseBackendError = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as { error?: string };
    if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
  } catch {
    // ignore parse errors
  }
  return `PDF export failed (${response.status})`;
};

export const downloadPdfExport = async (payload: PdfExportPayload): Promise<void> => {
  const uiLanguage =
    typeof document !== "undefined"
      ? (document.documentElement.lang || navigator.language || "").trim()
      : "";
  const requestPayload = {
    ...payload,
    uiLanguage,
  };

  const response = await fetch("/api/pdf/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    throw new Error(await parseBackendError(response));
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  const suggestedFileName =
    parseFileNameFromDisposition(response.headers.get("Content-Disposition")) ||
    payload.fileName ||
    "planotto-export.pdf";

  link.href = objectUrl;
  link.download = suggestedFileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
};
