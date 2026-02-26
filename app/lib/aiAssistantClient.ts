export type AiAssistAction =
  | "ingredient_hints"
  | "tag_hints"
  | "servings_hint"
  | "recipe_image"
  | "menu_suggestion"
  | "assistant_help"
  | "import_recipe_url"
  | "import_recipe_photo"
  | "recipe_translation";

interface AiAssistRequest<TPayload extends Record<string, unknown>> {
  action: AiAssistAction;
  payload: TPayload;
}

interface IngredientHintItem {
  index: number;
  suggestions: string[];
}

export interface IngredientHintsResponse {
  items: IngredientHintItem[];
}

export interface TagHintsResponse {
  suggestedTags: string[];
  message?: string;
}

export interface ServingsHintResponse {
  suggestedServings: number | null;
  message?: string;
}

export interface RecipeImageResponse {
  imageUrl?: string;
  prompt?: string;
  message?: string;
}

export interface MenuSuggestionResponse {
  message?: string;
}

export interface AssistantHelpResponse {
  message?: string;
}

export interface ImportedIngredient {
  name: string;
  amount: number;
  unit: string;
  needsReview?: boolean;
}

export interface ImportedRecipeDraft {
  title: string;
  shortDescription?: string;
  instructions?: string;
  servings?: number | null;
  timeMinutes?: number | null;
  image?: string;
  tags?: string[];
  ingredients: ImportedIngredient[];
}

export interface RecipeImportResponse {
  recipe: ImportedRecipeDraft | null;
  message?: string;
  issues?: string[];
}

export interface RecipeTranslationDraft {
  title: string;
  shortDescription?: string;
  description?: string;
  instructions?: string;
}

export interface RecipeTranslationDraftResponse {
  translation: RecipeTranslationDraft;
  message?: string;
}

const callAssist = async <TResponse, TPayload extends Record<string, unknown>>(
  body: AiAssistRequest<TPayload>
): Promise<TResponse> => {
  const response = await fetch("/api/ai/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let data: (TResponse & { error?: string }) | null = null;
  try {
    data = rawText ? (JSON.parse(rawText) as TResponse & { error?: string }) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const backendError = data && typeof data.error === "string" ? data.error : "";
    throw new Error(backendError || `Ошибка ИИ-помощника (${response.status}).`);
  }
  if (!data) {
    throw new Error("Пустой ответ от ИИ-помощника.");
  }
  return data;
};

export const getIngredientHints = (payload: {
  ingredients: Array<{ index: number; name: string }>;
  knownProducts: string[];
}) => callAssist<IngredientHintsResponse, typeof payload>({ action: "ingredient_hints", payload });

export const getTagHints = (payload: {
  title: string;
  shortDescription: string;
  instructions: string;
  ingredients: string[];
}) => callAssist<TagHintsResponse, typeof payload>({ action: "tag_hints", payload });

export const getServingsHint = (payload: {
  title: string;
  ingredients: Array<{ name: string; amount: number; unit: string }>;
}) => callAssist<ServingsHintResponse, typeof payload>({ action: "servings_hint", payload });

export const getRecipeImage = (payload: {
  title: string;
  shortDescription: string;
  instructions: string;
  ingredients: string[];
}) => callAssist<RecipeImageResponse, typeof payload>({ action: "recipe_image", payload });

export const getMenuSuggestion = (payload: {
  peopleCount: number;
  days: number;
  constraints: string;
  newDishPercent: number;
  recipes: string[];
}) => callAssist<MenuSuggestionResponse, typeof payload>({ action: "menu_suggestion", payload });

export const getAssistantHelp = (payload: {
  question: string;
  pathname: string;
  locale?: "ru" | "en" | "es";
}) => callAssist<AssistantHelpResponse, typeof payload>({ action: "assistant_help", payload });

export const importRecipeByUrl = (payload: {
  url: string;
  knownProducts: string[];
}) => callAssist<RecipeImportResponse, typeof payload>({ action: "import_recipe_url", payload });

export const importRecipeByPhoto = (payload: {
  imageDataUrls: string[];
  knownProducts: string[];
}) => callAssist<RecipeImportResponse, typeof payload>({ action: "import_recipe_photo", payload });

export const getRecipeTranslationDraft = (payload: {
  sourceLanguage: "ru" | "en" | "es";
  targetLanguage: "ru" | "en" | "es";
  title: string;
  shortDescription?: string;
  description?: string;
  instructions?: string;
}) => callAssist<RecipeTranslationDraftResponse, typeof payload>({ action: "recipe_translation", payload });
