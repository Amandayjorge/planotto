export const INAPPROPRIATE_CONTENT_MESSAGE = "Este contenido no es apropiado";

const BANNED_WORD_STEMS = [
  "хуй",
  "пизд",
  "еба",
  "бляд",
  "сук",
  "нах",
  "мудак",
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "cunt",
  "puta",
  "mierda",
  "joder",
  "coño",
  "gilipoll",
  "pendej",
] as const;

interface ModerationIngredientLike {
  name?: string;
  note?: string;
}

export interface RecipeModerationPayload {
  title?: string;
  shortDescription?: string;
  description?: string;
  instructions?: string;
  notes?: string;
  tags?: string[];
  ingredients?: ModerationIngredientLike[];
}

const normalizeModerationText = (value: string): string =>
  value
    .toLocaleLowerCase("ru-RU")
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");

const containsBannedWord = (value: string): boolean => {
  const normalized = normalizeModerationText(value);
  if (!normalized) return false;
  return BANNED_WORD_STEMS.some((stem) => normalized.includes(stem));
};

export const hasInappropriateRecipeContent = (payload: RecipeModerationPayload): boolean => {
  const chunks: string[] = [
    String(payload.title || ""),
    String(payload.shortDescription || ""),
    String(payload.description || ""),
    String(payload.instructions || ""),
    String(payload.notes || ""),
  ];

  (payload.tags || []).forEach((tag) => chunks.push(String(tag || "")));
  (payload.ingredients || []).forEach((item) => {
    chunks.push(String(item?.name || ""));
    chunks.push(String(item?.note || ""));
  });

  return chunks.some((chunk) => containsBannedWord(chunk));
};
