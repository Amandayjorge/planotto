import { NextResponse } from "next/server";
import { RECIPE_TAGS } from "../../../lib/recipeTags";

type ActionType =
  | "ingredient_hints"
  | "tag_hints"
  | "servings_hint"
  | "recipe_image"
  | "menu_suggestion"
  | "assistant_help"
  | "import_recipe_url"
  | "import_recipe_photo";

interface AiRequestBody {
  action: ActionType;
  payload?: Record<string, unknown>;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";
const FOOD_IMAGE_URL = "https://loremflickr.com";
const FAL_OCR_ENDPOINT = process.env.FAL_OCR_ENDPOINT || "https://queue.fal.run/fal-ai/got-ocr/v2";
const FAL_OCR_POLL_ATTEMPTS = 20;
const FAL_OCR_POLL_DELAY_MS = 1200;
const FUSIONBRAIN_BASE_URL = process.env.FUSIONBRAIN_BASE_URL || "https://api-key.fusionbrain.ai/key/api/v1";
const FUSIONBRAIN_POLL_ATTEMPTS = 15;
const FUSIONBRAIN_POLL_DELAY_MS = 1500;

const buildGeneratedRecipeImageUrl = (prompt: string): string => {
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const nonce = Date.now();
  const category = /soup|рагу|суп|broth/i.test(prompt) ? "soup,food" : "food,meal";
  return `${FOOD_IMAGE_URL}/1024/1024/${category}?lock=${seed}&_=${nonce}`;
};

const UNITS = ["г", "кг", "мл", "л", "шт", "ч.л.", "ст.л.", "по вкусу"] as const;

const safeString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const safeStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => safeString(item)).filter(Boolean) : [];
const safeImageDataUrlArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => safeString(item))
        .filter((item) => item.startsWith("data:image/"))
    : [];

const getFalKey = (): string => {
  const key = process.env.FAL_KEY || process.env.FAL_API_KEY || "";
  return safeString(key);
};

const falHeaders = (key: string, mode: "Key" | "Bearer"): Record<string, string> => ({
  Authorization: `${mode} ${key}`,
  "Content-Type": "application/json",
});

const falFetchJson = async (
  url: string,
  init: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
  },
  key: string
): Promise<{ ok: boolean; status: number; json: unknown }> => {
  const call = async (mode: "Key" | "Bearer") => {
    const response = await fetch(url, {
      method: init.method,
      headers: falHeaders(key, mode),
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json };
  };

  const keyMode = await call("Key");
  if (keyMode.ok || (keyMode.status !== 401 && keyMode.status !== 403)) return keyMode;
  return call("Bearer");
};

const collectTextCandidates = (value: unknown, output: string[], depth = 0): void => {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length > 2 && !/^https?:\/\//i.test(text)) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextCandidates(item, output, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const priorityKeys = [
      "text",
      "ocr_text",
      "content",
      "markdown",
      "result",
      "results",
      "output",
      "outputs",
      "pages",
      "data",
    ];
    for (const key of priorityKeys) {
      if (key in record) collectTextCandidates(record[key], output, depth + 1);
    }
    for (const item of Object.values(record)) {
      collectTextCandidates(item, output, depth + 1);
    }
  }
};

const extractFalOcrText = (payload: unknown): string => {
  const chunks: string[] = [];
  collectTextCandidates(payload, chunks);
  const unique = Array.from(new Set(chunks.map((item) => item.trim()).filter(Boolean)));
  return unique.join("\n").trim();
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FusionBrainCredentials = {
  apiKey: string;
  secretKey: string;
};

const getFusionBrainCredentials = (): FusionBrainCredentials | null => {
  const combined = safeString(process.env.FUSIONBRAIN_CREDENTIALS);
  if (combined.includes(":")) {
    const [apiKeyRaw, secretKeyRaw] = combined.split(":", 2);
    const apiKey = safeString(apiKeyRaw);
    const secretKey = safeString(secretKeyRaw);
    if (apiKey && secretKey) return { apiKey, secretKey };
  }

  const apiKey = safeString(process.env.FUSIONBRAIN_API_KEY);
  const secretKey = safeString(process.env.FUSIONBRAIN_SECRET_KEY);
  if (apiKey && secretKey) return { apiKey, secretKey };
  return null;
};

const getFusionBrainHeaders = (credentials: FusionBrainCredentials): Record<string, string> => ({
  "X-Key": `Key ${credentials.apiKey}`,
  "X-Secret": `Secret ${credentials.secretKey}`,
});

const requestFusionBrainModelId = async (credentials: FusionBrainCredentials): Promise<number | null> => {
  const response = await fetch(`${FUSIONBRAIN_BASE_URL}/models`, {
    method: "GET",
    headers: getFusionBrainHeaders(credentials),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as Array<{ id?: unknown }>;
  if (!Array.isArray(data) || data.length === 0) return null;
  const firstId = Number(data[0]?.id);
  return Number.isFinite(firstId) ? firstId : null;
};

const generateImageWithFusionBrain = async (
  prompt: string
): Promise<{ imageUrl: string | null; error: string | null }> => {
  const credentials = getFusionBrainCredentials();
  if (!credentials) {
    return { imageUrl: null, error: "Ключ генерации изображений не настроен." };
  }

  const modelId = await requestFusionBrainModelId(credentials);
  if (!modelId) {
    return { imageUrl: null, error: "Не удалось получить модель генерации изображений." };
  }

  const formData = new FormData();
  formData.append("model_id", String(modelId));
  formData.append(
    "params",
    JSON.stringify({
      type: "GENERATE",
      numImages: 1,
      width: 1024,
      height: 1024,
      generateParams: {
        query: prompt,
      },
    })
  );

  const runResponse = await fetch(`${FUSIONBRAIN_BASE_URL}/text2image/run`, {
    method: "POST",
    headers: getFusionBrainHeaders(credentials),
    body: formData,
  });
  if (!runResponse.ok) {
    const errorText = await runResponse.text();
    return {
      imageUrl: null,
      error: `Сервис генерации вернул ошибку (${runResponse.status}): ${safeString(errorText) || "без деталей"}.`,
    };
  }

  const runData = (await runResponse.json()) as { uuid?: unknown };
  const uuid = safeString(runData.uuid);
  if (!uuid) {
    return { imageUrl: null, error: "Сервис генерации не вернул идентификатор задачи." };
  }

  for (let attempt = 0; attempt < FUSIONBRAIN_POLL_ATTEMPTS; attempt += 1) {
    const statusResponse = await fetch(`${FUSIONBRAIN_BASE_URL}/text2image/status/${uuid}`, {
      method: "GET",
      headers: getFusionBrainHeaders(credentials),
    });
    if (statusResponse.ok) {
      const statusData = (await statusResponse.json()) as {
        status?: unknown;
        images?: unknown;
        errorDescription?: unknown;
      };
      const status = safeString(statusData.status).toUpperCase();
      const images = Array.isArray(statusData.images) ? statusData.images : [];
      const firstBase64 = safeString(images[0]);
      if (status === "DONE" && firstBase64) {
        return {
          imageUrl: `data:image/png;base64,${firstBase64}`,
          error: null,
        };
      }
      if (status === "FAIL") {
        return {
          imageUrl: null,
          error: safeString(statusData.errorDescription) || "Сервис генерации не смог создать изображение.",
        };
      }
    }
    await sleep(FUSIONBRAIN_POLL_DELAY_MS);
  }

  return { imageUrl: null, error: "Сервис генерации не успел подготовить изображение. Повторите попытку." };
};

const normalizeUnit = (value: string): string => {
  const raw = value.toLowerCase().trim();
  if (!raw) return "шт";
  if (raw === "g" || raw === "гр" || raw === "грамм" || raw === "граммов") return "г";
  if (raw === "kg" || raw === "кг") return "кг";
  if (raw === "ml" || raw === "мл") return "мл";
  if (raw === "l" || raw === "л" || raw === "литр") return "л";
  if (raw === "шт" || raw === "штук" || raw === "шт.") return "шт";
  if (raw === "ч.л." || raw === "ч.л" || raw === "чайная ложка") return "ч.л.";
  if (raw === "ст.л." || raw === "ст.л" || raw === "столовая ложка") return "ст.л.";
  if (raw.includes("вкус")) return "по вкусу";
  return UNITS.includes(raw as (typeof UNITS)[number]) ? raw : "шт";
};

const parseAmountValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const text = safeString(value).toLowerCase();
  if (!text) return 0;
  const normalized = text.replace(",", ".").replace(/\s+/g, " ");
  const rangeMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|до)\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    const left = Number(rangeMatch[1]);
    const right = Number(rangeMatch[2]);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return Math.round(((left + right) / 2) * 100) / 100;
    }
  }
  const singleMatch = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!singleMatch) return 0;
  const parsed = Number(singleMatch[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const detectUnitFromText = (value: string): string => {
  const text = value.toLowerCase();
  if (!text) return "шт";
  if (text.includes("по вкусу")) return "по вкусу";
  if (/\bкг\b/.test(text)) return "кг";
  if (/\bг\b/.test(text) || text.includes("гр")) return "г";
  if (/\bмл\b/.test(text)) return "мл";
  if (/\bл\b/.test(text) || text.includes("литр")) return "л";
  if (text.includes("ч.л") || text.includes("чайн")) return "ч.л.";
  if (text.includes("ст.л") || text.includes("столов")) return "ст.л.";
  if (
    text.includes("шт") ||
    text.includes("луковиц") ||
    text.includes("горошин") ||
    text.includes("лист")
  ) {
    return "шт";
  }
  return "шт";
};

const cleanupIngredientName = (value: string): string => {
  if (!value) return "";
  let result = value.trim();
  result = result.replace(
    /^(\d+(?:[.,]\d+)?(?:\s*(?:-|–|—|до)\s*\d+(?:[.,]\d+)?)?)\s*(кг|г|гр|мл|л|шт|ч\.?\s*л\.?|ст\.?\s*л\.?|луковиц[аы]?|горошин|лист(?:а|ов)?)\b\s*/i,
    ""
  );
  result = result.replace(/^[,:;.\-–—\s]+/, "").replace(/[,:;.\-–—\s]+$/, "");
  return result.trim();
};

const getOpenRouterKey = (): string => {
  const key =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENROUTER_KEY ||
    process.env.OPENTOUTERKEY ||
    "";
  return key.trim();
};

const extractJsonBlock = (text: string): Record<string, unknown> | null => {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

type OpenRouterResult = {
  json: Record<string, unknown> | null;
  error: string | null;
};

const extractOpenRouterErrorMessage = (raw: string): string => {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as
      | { error?: string | { message?: string; code?: string } }
      | undefined;
    const errorField = parsed?.error;
    if (typeof errorField === "string" && errorField.trim()) {
      return errorField.trim();
    }
    if (errorField && typeof errorField === "object") {
      const message = safeString((errorField as { message?: unknown }).message);
      if (message) return message;
      const code = safeString((errorField as { code?: unknown }).code);
      if (code) return code;
    }
  } catch {
    // ignore JSON parse issues
  }
  return raw.slice(0, 300);
};

const mapOpenRouterError = (status: number): string => {
  if (status === 429) return "Сервис распознавания перегружен. Попробуйте позже.";
  if (status === 400 || status === 422) return "Не удалось обработать фото для распознавания.";
  if (status === 401 || status === 403) return "Сервис распознавания временно недоступен.";
  return "Сервис распознавания временно недоступен.";
};

const callOpenRouterWithDetails = async (
  system: string,
  user: string,
  imageDataUrls: string[] = [],
  model: string = DEFAULT_MODEL
): Promise<OpenRouterResult> => {
  const key = getOpenRouterKey();
  if (!key) {
    console.error("[ai/assist] OPENROUTER_API_KEY is missing");
    return { json: null, error: "Сервис распознавания временно недоступен." };
  }

  const userContent =
    imageDataUrls.length > 0
      ? [
          { type: "text", text: user },
          ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : user;

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://planotto.local",
      "X-Title": "Planotto Assistant",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    const details = extractOpenRouterErrorMessage(rawText);
    const mapped = mapOpenRouterError(response.status);
    console.error("[ai/assist] OpenRouter request failed", {
      status: response.status,
      details,
      model,
      hasImages: imageDataUrls.length > 0,
    });
    return { json: null, error: mapped };
  }
  let data: {
    choices?: Array<{ message?: { content?: string } }>;
  } = {};
  try {
    data = JSON.parse(rawText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
  } catch {
    return { json: null, error: "Сервис распознавания вернул некорректный ответ." };
  }
  return { json: extractJsonBlock(data.choices?.[0]?.message?.content || ""), error: null };
};

const callOpenRouter = async (
  system: string,
  user: string,
  imageDataUrls: string[] = [],
  model: string = DEFAULT_MODEL
): Promise<Record<string, unknown> | null> => {
  const result = await callOpenRouterWithDetails(system, user, imageDataUrls, model);
  return result.json;
};

const fallbackIngredientHints = (payload: Record<string, unknown>) => {
  const knownProducts = safeStringArray(payload.knownProducts);
  const ingredients = Array.isArray(payload.ingredients)
    ? payload.ingredients
        .map((item) => item as { index?: unknown; name?: unknown })
        .map((item) => ({ index: Number(item.index), name: safeString(item.name) }))
        .filter((item) => Number.isInteger(item.index) && item.name.length > 0)
    : [];

  return {
    items: ingredients.map((item) => ({
      index: item.index,
      suggestions: knownProducts
        .filter((name) => name.toLowerCase().includes(item.name.toLowerCase()))
        .slice(0, 4),
    })),
  };
};

const fallbackTagHints = (payload: Record<string, unknown>) => {
  const text = [
    safeString(payload.title),
    safeString(payload.shortDescription),
    safeString(payload.instructions),
    safeStringArray(payload.ingredients).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  const tags: string[] = [];
  if (text.includes("веган")) tags.push("веган");
  if (text.includes("вегет")) tags.push("вегетарианский");
  if (text.includes("без глют")) tags.push("без глютена");
  if (text.includes("без лакт")) tags.push("без лактозы");
  if (text.includes("завтрак")) tags.push("завтрак");
  if (text.includes("обед")) tags.push("обед");
  if (text.includes("ужин")) tags.push("ужин");
  if (text.includes("быстр")) tags.push("быстро (до 30 минут)");

  return { suggestedTags: tags.slice(0, 6), message: "Подсказка готова." };
};

const fallbackServingsHint = (payload: Record<string, unknown>) => {
  const ingredients = Array.isArray(payload.ingredients)
    ? payload.ingredients.map((item) => item as { amount?: unknown })
    : [];

  const total = ingredients.reduce((sum, item) => {
    const amount = Number(item.amount || 0);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  const servings = total > 1500 ? 5 : total > 900 ? 4 : total > 500 ? 3 : 2;
  return {
    suggestedServings: servings,
    message: `По ингредиентам похоже на ${servings}-${servings + 1} порции. Указать?`,
  };
};

const fallbackImage = (payload: Record<string, unknown>) => {
  const title = safeString(payload.title) || "домашнее блюдо";
  const ingredients = safeStringArray(payload.ingredients).slice(0, 5).join(", ");
  const prompt = [
    `realistic home-cooked ${title}`,
    ingredients ? `ingredients focus: ${ingredients}` : "",
    "close-up food photography, plated dish, natural kitchen light",
    "no people, no faces, no text, no letters, no logo, no watermark, no qr code, no poster, no robot, no mascot",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    prompt,
    imageUrl: buildGeneratedRecipeImageUrl(prompt),
    message: "Фото подготовлено. Проверьте и при необходимости замените.",
  };
};

const fallbackMenuSuggestion = (payload: Record<string, unknown>) => {
  const people = Number(payload.peopleCount || 2);
  const days = Number(payload.days || 7);
  return {
    message: `Базовый план: ${days} дней, ${people} чел. Чередуйте быстрые и более сложные блюда.`,
  };
};

const fallbackAssistantHelp = (payload: Record<string, unknown>) => {
  const question = safeString(payload.question).toLowerCase();
  const pathname = safeString(payload.pathname);

  if (
    question.includes("яичниц") ||
    question.includes("омлет") ||
    question.includes("как приготовить")
  ) {
    return {
      message:
        "Быстрый вариант яичницы: разогрейте сковороду, добавьте немного масла, вбейте 2-3 яйца, посолите, готовьте 2-4 минуты на среднем огне до нужной степени. Для нежной текстуры накройте крышкой на 1 минуту.",
    };
  }

  if (pathname.startsWith("/recipes")) {
    return {
      message:
        "В рецептах можно: добавить название, ингредиенты, шаги, теги и фото. Если хотите, напишите конкретный вопрос по блюду, и я дам пошаговый ответ.",
    };
  }
  if (pathname.startsWith("/menu")) {
    return {
      message:
        "В меню выберите период сверху и добавляйте блюда по дням. Могу предложить простой план, если напишете ограничения и количество человек.",
    };
  }
  if (pathname.startsWith("/shopping-list")) {
    return {
      message:
        "Список покупок собирается из меню. Отмечайте купленное — позиции можно переносить в кладовку.",
    };
  }
  if (pathname.startsWith("/pantry")) {
    return {
      message:
        "В кладовке храните остатки по названию, количеству и единице. Если названия совпадают, количество суммируется.",
    };
  }
  return {
    message:
      "Задайте вопрос обычным языком: например «как приготовить яичницу» или «почему продукт не попал в покупки».",
  };
};

const isCookingQuestion = (text: string): boolean => {
  const value = text.toLowerCase();
  return (
    value.includes("как приготовить") ||
    value.includes("как сделать") ||
    value.includes("рецепт ") ||
    value.includes("пожарить") ||
    value.includes("сварить") ||
    value.includes("запечь") ||
    value.includes("яичниц") ||
    value.includes("омлет")
  );
};

const looksLikeUiInstruction = (text: string): boolean => {
  const value = text.toLowerCase();
  return (
    value.includes("перейдите в раздел") ||
    value.includes("нажмите кнопку") ||
    value.includes("добавить рецепт")
  );
};

const fallbackImportedDraft = (source: "url" | "photo", payload: Record<string, unknown>) => {
  const title = source === "url" ? "Импортированный рецепт по ссылке" : "Импортированный рецепт по фото";
  const knownProducts = safeStringArray(payload.knownProducts);
  const photoItems = safeImageDataUrlArray(payload.imageDataUrls);
  const singlePhoto = safeString(payload.imageDataUrl);
  const photosCount = source === "photo"
    ? (photoItems.length > 0 ? photoItems.length : singlePhoto.startsWith("data:image/") ? 1 : 0)
    : 0;
  const sourceTitle = source === "photo" && photosCount > 1 ? `Импортированный рецепт по фото (${photosCount})` : title;
  if (source === "photo") {
    return {
      recipe: null,
      message: "Не удалось уверенно распознать рецепт с фото. Попробуйте более четкое фото и крупный текст.",
      issues:
        photosCount > 1
          ? [`Обработано фото: ${photosCount}. Распознавание оказалось неполным.`]
          : ["Распознавание оказалось неполным."],
    };
  }

  return {
    recipe: {
      title: sourceTitle,
      shortDescription: "",
      instructions: "",
      servings: null,
      timeMinutes: null,
      image: "",
      tags: [],
      ingredients: knownProducts.slice(0, 3).map((name) => ({
        name,
        amount: 0,
        unit: "шт",
        needsReview: true,
      })),
    },
    message: "Черновик создан. Проверьте ингредиенты и шаги перед сохранением.",
    issues: ["Нужно проверить единицы и количества."],
  };
};

type ParsedRecipeLike = {
  title: string;
  shortDescription: string;
  instructions: string;
  servings: number | null;
  timeMinutes: number | null;
  image: string;
  tags: string[];
  ingredients: Array<{ name: string; amount: number; unit: string; needsReview: boolean }>;
};

const parseRecipeFromAi = (input: unknown): ParsedRecipeLike | null => {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const ingredients = Array.isArray(raw.ingredients)
    ? raw.ingredients
        .map((item) => {
          if (typeof item === "string") {
            const line = safeString(item);
            return {
              name: cleanupIngredientName(line),
              amount: parseAmountValue(line),
              unit: normalizeUnit(detectUnitFromText(line)),
              needsReview: true,
            };
          }
          return item as Record<string, unknown>;
        })
        .map((item) => {
          if ("name" in item && "amount" in item && "unit" in item) {
            const typed = item as {
              name?: unknown;
              amount?: unknown;
              unit?: unknown;
              needsReview?: unknown;
            };
            const rawName = safeString(typed.name);
            const amountFromField = parseAmountValue(typed.amount);
            const amountFromName = parseAmountValue(rawName);
            const rawUnit = normalizeUnit(safeString(typed.unit));
            const unitFromName = normalizeUnit(detectUnitFromText(rawName));
            const finalUnit =
              rawUnit === "шт" && unitFromName !== "шт" ? unitFromName : rawUnit;
            const finalAmount = amountFromField > 0 ? amountFromField : amountFromName;
            const cleanedName = cleanupIngredientName(rawName) || rawName;

            return {
              name: cleanedName,
              amount: finalAmount,
              unit:
                finalAmount === 0 &&
                (cleanedName.toLowerCase().includes("соль") ||
                  cleanedName.toLowerCase().includes("перец"))
                  ? "по вкусу"
                  : finalUnit,
              needsReview: Boolean(typed.needsReview ?? true),
            };
          }
          const fallbackName = safeString((item as Record<string, unknown>).name);
          return {
            name: cleanupIngredientName(fallbackName),
            amount: parseAmountValue(fallbackName),
            unit: normalizeUnit(detectUnitFromText(fallbackName)),
            needsReview: true,
          };
        })
        .filter((item) => item.name.length > 0)
    : [];

  const servingsRaw = Number(raw.servings || 0);
  const timeRaw = Number(raw.timeMinutes || 0);
  return {
    title: safeString(raw.title),
    shortDescription: safeString(raw.shortDescription),
    instructions: safeString(raw.instructions),
    servings: Number.isFinite(servingsRaw) && servingsRaw > 0 ? servingsRaw : null,
    timeMinutes: Number.isFinite(timeRaw) && timeRaw > 0 ? timeRaw : null,
    image: safeString(raw.image),
    tags: safeStringArray(raw.tags),
    ingredients,
  };
};

const mergeParsedRecipes = (parts: ParsedRecipeLike[]): ParsedRecipeLike | null => {
  if (parts.length === 0) return null;
  const title = parts.map((part) => part.title).find((value) => value.length > 0) || "";
  const shortDescription =
    parts.map((part) => part.shortDescription).find((value) => value.length > 0) || "";
  const instructions = parts
    .map((part) => part.instructions)
    .filter((value) => value.length > 0)
    .join("\n\n")
    .trim();
  const servings = parts.map((part) => part.servings).find((value) => Boolean(value)) || null;
  const timeMinutes = parts.map((part) => part.timeMinutes).find((value) => Boolean(value)) || null;
  const image = parts.map((part) => part.image).find((value) => value.length > 0) || "";
  const tags = Array.from(new Set(parts.flatMap((part) => part.tags).filter(Boolean)));

  const ingredientMap = new Map<string, { name: string; amount: number; unit: string; needsReview: boolean }>();
  for (const part of parts) {
    for (const item of part.ingredients) {
      const key = `${item.name.toLowerCase()}__${item.unit}`;
      if (!ingredientMap.has(key)) {
        ingredientMap.set(key, { ...item });
      } else {
        const prev = ingredientMap.get(key)!;
        ingredientMap.set(key, {
          ...prev,
          amount: Math.max(0, prev.amount) + Math.max(0, item.amount),
          needsReview: prev.needsReview || item.needsReview,
        });
      }
    }
  }

  return {
    title,
    shortDescription,
    instructions,
    servings,
    timeMinutes,
    image,
    tags,
    ingredients: Array.from(ingredientMap.values()),
  };
};

const toRecipeResponse = (
  parsed: ParsedRecipeLike,
  fallbackTitle: string,
  message: string,
  issues: string[] = []
) => ({
  recipe: {
    title: parsed.title || fallbackTitle,
    shortDescription: parsed.shortDescription,
    instructions: parsed.instructions,
    servings: parsed.servings,
    timeMinutes: parsed.timeMinutes,
    image: parsed.image,
    tags: parsed.tags,
    ingredients: parsed.ingredients,
  },
  message,
  issues,
});

const BASE_OCR_FALLBACK_ISSUE = "Используем базовое распознавание. Результат может быть неполным.";

const normalizeImportIssues = (issues: string[]): string[] => {
  const cleaned = issues.map((issue) => safeString(issue)).filter(Boolean);
  return Array.from(new Set(cleaned));
};

const runFalOcrForRecipeImport = async (
  imageDataUrls: string[],
  knownProducts: string[]
): Promise<{ parsed: ParsedRecipeLike | null; message: string; issues: string[] }> => {
  const falKey = getFalKey();
  if (!falKey) {
    return {
      parsed: null,
      message: "",
      issues: [BASE_OCR_FALLBACK_ISSUE],
    };
  }

  const enqueue = await falFetchJson(
    FAL_OCR_ENDPOINT,
    {
      method: "POST",
      body: {
        input: {
          image_urls: imageDataUrls,
          language: "ru",
          multi_page: true,
        },
      },
    },
    falKey
  );

  if (!enqueue.ok) {
    return {
      parsed: null,
      message: "",
      issues: [BASE_OCR_FALLBACK_ISSUE, "Сервис распознавания фото временно недоступен. Используем базовый режим."],
    };
  }

  const enqueueData = (enqueue.json || {}) as Record<string, unknown>;
  let ocrPayload: unknown = enqueueData;
  const statusUrl = safeString(enqueueData.status_url);
  const responseUrl = safeString(enqueueData.response_url);

  if (statusUrl || responseUrl) {
    for (let attempt = 0; attempt < FAL_OCR_POLL_ATTEMPTS; attempt += 1) {
      const pollUrl = statusUrl || responseUrl;
      if (!pollUrl) break;
      const status = await falFetchJson(
        pollUrl,
        {
          method: "GET",
        },
        falKey
      );
      if (status.ok) {
        const statusData = (status.json || {}) as Record<string, unknown>;
        const statusValue = safeString(statusData.status).toUpperCase();
        const maybePayload = statusData.response ?? statusData.output ?? statusData.result ?? statusData;
        if (!statusValue || statusValue === "COMPLETED" || statusValue === "DONE") {
          ocrPayload = maybePayload;
          break;
        }
        if (statusValue === "FAILED" || statusValue === "ERROR") {
          return {
            parsed: null,
            message: "",
            issues: [BASE_OCR_FALLBACK_ISSUE, "Не удалось распознать часть фото. Используем базовый режим."],
          };
        }
      }
      await sleep(FAL_OCR_POLL_DELAY_MS);
    }
  }

  const ocrText = extractFalOcrText(ocrPayload);
  if (!ocrText) {
    return {
      parsed: null,
      message: "",
      issues: [BASE_OCR_FALLBACK_ISSUE, "Текст с фото распознан не полностью. Продолжайте вручную при необходимости."],
    };
  }

  const normalizedText = ocrText.slice(0, 14000);
  const parserSystem =
    "Ты структурируешь текст OCR рецепта на русском языке. " +
    "Верни строго JSON: {\"recipe\":{\"title\":\"\",\"shortDescription\":\"\",\"instructions\":\"\",\"servings\":null,\"timeMinutes\":null,\"image\":\"\",\"tags\":[],\"ingredients\":[{\"name\":\"\",\"amount\":0,\"unit\":\"шт\",\"needsReview\":true}]},\"message\":\"\",\"issues\":[]} . " +
    "Не выдумывай данные. Сохраняй порядок шагов. Название ингредиента возвращай без количества и единицы. " +
    "Единицы только: г, кг, мл, л, шт, ч.л., ст.л., по вкусу.";

  const ai = await callOpenRouter(
    parserSystem,
    JSON.stringify({
      ocrText: normalizedText,
      knownProducts: knownProducts.slice(0, 200),
    }),
    [],
    DEFAULT_MODEL
  );

  if (ai && ai.recipe && typeof ai.recipe === "object") {
    const parsed = parseRecipeFromAi(ai.recipe);
    if (parsed) {
      return {
        parsed,
        message: safeString(ai.message) || "Импорт выполнен через OCR. Проверьте перед сохранением.",
        issues: safeStringArray(ai.issues),
      };
    }
  }

  return {
    parsed: null,
    message: "",
    issues: [BASE_OCR_FALLBACK_ISSUE, "Не удалось полностью структурировать текст. Часть данных заполните вручную."],
  };
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AiRequestBody;
    const action = body.action;
    const payload = (body.payload || {}) as Record<string, unknown>;

    if (!action) {
      return NextResponse.json({ error: "action is required" }, { status: 400 });
    }

    if (action === "ingredient_hints") {
      const system =
        "Нормализуй названия ингредиентов и верни JSON: {\"items\":[{\"index\":0,\"suggestions\":[\"...\"]}]}";
      const ai = await callOpenRouter(system, JSON.stringify(payload));
      const items = Array.isArray(ai?.items) ? ai.items : null;
      return NextResponse.json(items ? { items } : fallbackIngredientHints(payload));
    }

    if (action === "tag_hints") {
      const system =
        "Выбери теги только из allowedTags и верни JSON: {\"suggestedTags\":[...],\"message\":\"...\"}";
      const ai = await callOpenRouter(
        system,
        JSON.stringify({ ...payload, allowedTags: RECIPE_TAGS })
      );
      if (ai) {
        const suggestedTags = safeStringArray(ai.suggestedTags).filter((tag) =>
          (RECIPE_TAGS as readonly string[]).includes(tag)
        );
        return NextResponse.json({
          suggestedTags,
          message: safeString(ai.message) || "Подсказка по тегам готова.",
        });
      }
      return NextResponse.json(fallbackTagHints(payload));
    }

    if (action === "servings_hint") {
      const system =
        "Оцени порции и верни JSON: {\"suggestedServings\":2,\"message\":\"...\"}.";
      const ai = await callOpenRouter(system, JSON.stringify(payload));
      if (ai) {
        const value = Number(ai.suggestedServings || 0);
        return NextResponse.json({
          suggestedServings: Number.isFinite(value) && value > 0 ? value : null,
          message: safeString(ai.message) || "Подсказка по порциям готова.",
        });
      }
      return NextResponse.json(fallbackServingsHint(payload));
    }

    if (action === "recipe_image") {
      const fallback = fallbackImage(payload);
      try {
        const generated = await generateImageWithFusionBrain(fallback.prompt);
        if (generated.imageUrl) {
          return NextResponse.json({
            prompt: fallback.prompt,
            imageUrl: generated.imageUrl,
            message: "Фото сгенерировано.",
          });
        }
        return NextResponse.json({
          ...fallback,
          message: generated.error
            ? `Не удалось сгенерировать фото по ключу: ${generated.error} Использую запасной вариант.`
            : fallback.message,
        });
      } catch {
        return NextResponse.json({
          ...fallback,
          message: "Сервис генерации недоступен. Использую запасной вариант фото.",
        });
      }
    }

    if (action === "menu_suggestion") {
      const ai = await callOpenRouter(
        "Верни JSON: {\"message\":\"...\"}. Это рекомендация, не изменение данных.",
        JSON.stringify(payload)
      );
      const message = safeString(ai?.message);
      return NextResponse.json(message ? { message } : fallbackMenuSuggestion(payload));
    }

    if (action === "assistant_help") {
      const question = safeString(payload.question);
      if (isCookingQuestion(question) && (question.toLowerCase().includes("яичниц") || question.toLowerCase().includes("омлет"))) {
        return NextResponse.json(fallbackAssistantHelp(payload));
      }
      const system =
        "Ты Отто, дружелюбный помощник в приложении планирования питания. " +
        "Отвечай на русском, коротко и по делу. " +
        "Если вопрос про готовку (например яичница, омлет, суп), дай конкретные шаги приготовления. " +
        "Если вопрос по интерфейсу, объясни действия в контексте текущего раздела. " +
        "Если вопрос пользователя про готовку, сначала дай ответ именно по готовке, а не по интерфейсу. " +
        "Ничего не придумывай про функции, которых нет. " +
        "Верни только JSON: {\"message\":\"...\"}.";
      const ai = await callOpenRouter(system, JSON.stringify(payload));
      const message = safeString(ai?.message);
      if (message && isCookingQuestion(question) && looksLikeUiInstruction(message)) {
        return NextResponse.json(fallbackAssistantHelp(payload));
      }
      return NextResponse.json(message ? { message } : fallbackAssistantHelp(payload));
    }

    if (action === "import_recipe_url" || action === "import_recipe_photo") {
      const source = action === "import_recipe_url" ? "url" : "photo";
      const photoItems = safeImageDataUrlArray(payload.imageDataUrls);
      const singlePhoto = safeString(payload.imageDataUrl);
      const effectivePhotos =
        source === "photo"
          ? (photoItems.length > 0 ? photoItems : singlePhoto ? [singlePhoto] : [])
          : [];
      const system =
        source === "photo"
          ? "Ты OCR-помощник по рецептам на русском языке. " +
            "На входе 1+ фото страниц одного рецепта. Читай их в порядке передачи и собери единый рецепт. " +
            "Не придумывай ингредиенты и шаги, извлекай только то, что реально видно на фото. " +
            "Верни только JSON: {\"recipe\":{\"title\":\"\",\"shortDescription\":\"\",\"instructions\":\"\",\"servings\":null,\"timeMinutes\":null,\"image\":\"\",\"tags\":[],\"ingredients\":[{\"name\":\"\",\"amount\":0,\"unit\":\"шт\",\"needsReview\":true}]},\"message\":\"\",\"issues\":[]}. " +
            "Разделяй ингредиенты и шаги. Сохраняй порядок шагов и их нумерацию. " +
            "Единицы используй только: г, кг, мл, л, шт, ч.л., ст.л., по вкусу. " +
            "Если в строке диапазон (например 3-4), ставь среднее число и needsReview=true. " +
            "В поле name возвращай название без количества и единицы. Если есть сомнения — добавляй пояснение в issues."
          : "Ты извлекаешь рецепт по ссылке. Верни только JSON: {\"recipe\":{\"title\":\"\",\"shortDescription\":\"\",\"instructions\":\"\",\"servings\":null,\"timeMinutes\":null,\"image\":\"\",\"tags\":[],\"ingredients\":[{\"name\":\"\",\"amount\":0,\"unit\":\"шт\",\"needsReview\":true}]},\"message\":\"\",\"issues\":[]}. " +
            "Разделяй ингредиенты и шаги. Единицы используй только: г, кг, мл, л, шт, ч.л., ст.л., по вкусу. " +
            "Если в строке диапазон (например 3-4), ставь среднее число и needsReview=true. " +
            "В поле name возвращай название без количества и единицы. Если не уверен — ставь needsReview=true и добавь это в issues.";
      if (source === "photo") {
        const limitedPhotos = effectivePhotos.slice(0, 5);
        const photoIssues: string[] = [];
        const parsedParts: ParsedRecipeLike[] = [];
        const collectedMessages: string[] = [];

        const falResult = await runFalOcrForRecipeImport(
          limitedPhotos,
          safeStringArray(payload.knownProducts)
        );
        if (falResult.parsed) {
          return NextResponse.json(
            toRecipeResponse(
              falResult.parsed,
              "Импортированный рецепт по фото",
              falResult.message || "Импорт выполнен через OCR. Проверьте перед сохранением.",
              normalizeImportIssues(falResult.issues)
            )
          );
        }
        if (falResult.issues.length > 0) {
          photoIssues.push(...falResult.issues);
        }

        const combinedContext = {
          totalPages: limitedPhotos.length,
          pageOrder: "Переданы по порядку: 1..N",
          knownProducts: safeStringArray(payload.knownProducts).slice(0, 200),
        };
        const combinedResult = await callOpenRouterWithDetails(
          system,
          JSON.stringify(combinedContext),
          limitedPhotos,
          VISION_MODEL
        );
        if (combinedResult.error) {
          photoIssues.push(BASE_OCR_FALLBACK_ISSUE);
        } else {
          if (combinedResult.json?.message) {
            const message = safeString((combinedResult.json as Record<string, unknown>).message);
            if (message) collectedMessages.push(message);
          }
          if (combinedResult.json?.recipe) {
            const parsed = parseRecipeFromAi((combinedResult.json as Record<string, unknown>).recipe);
            if (parsed) parsedParts.push(parsed);
          }
        }

        if (parsedParts.length === 0) {
          for (let i = 0; i < limitedPhotos.length; i += 1) {
            const context = {
              page: i + 1,
              totalPages: limitedPhotos.length,
              knownProducts: safeStringArray(payload.knownProducts).slice(0, 200),
            };
            const result = await callOpenRouterWithDetails(
              system,
              JSON.stringify(context),
              [limitedPhotos[i]],
              VISION_MODEL
            );
            if (result.error) {
              photoIssues.push(BASE_OCR_FALLBACK_ISSUE);
              continue;
            }
            if (result.json?.message) {
              const message = safeString((result.json as Record<string, unknown>).message);
              if (message) collectedMessages.push(message);
            }
            if (result.json?.recipe) {
              const parsed = parseRecipeFromAi((result.json as Record<string, unknown>).recipe);
              if (parsed) parsedParts.push(parsed);
            }
          }
        }

        const merged = mergeParsedRecipes(parsedParts);
        const hasUsefulContent =
          Boolean(merged) &&
          (merged!.ingredients.length > 0 ||
            merged!.instructions.length > 0 ||
            merged!.shortDescription.length > 0 ||
            merged!.title.length > 0);

        if (!hasUsefulContent) {
          const fallback = fallbackImportedDraft(source, payload);
          const fallbackIssues = normalizeImportIssues([...(fallback.issues || []), ...photoIssues]);
          return NextResponse.json({
            ...fallback,
            issues: fallbackIssues,
          });
        }

        return NextResponse.json(
          toRecipeResponse(
            merged!,
            "Импортированный рецепт по фото",
            collectedMessages[0] ||
              (limitedPhotos.length > 1
                ? "Импорт выполнен по нескольким фото. Проверьте порядок шагов."
                : "Импорт выполнен. Проверьте перед сохранением."),
            normalizeImportIssues(photoIssues)
          )
        );
      }

      const ai = await callOpenRouter(system, JSON.stringify(payload), [], DEFAULT_MODEL);
      if (ai && ai.recipe && typeof ai.recipe === "object") {
        const parsed = parseRecipeFromAi(ai.recipe);
        if (parsed) {
          return NextResponse.json(
            toRecipeResponse(
              parsed,
              "Импортированный рецепт",
              safeString(ai.message) || "Импорт выполнен. Проверьте перед сохранением.",
              safeStringArray(ai.issues)
            )
          );
        }
      }
      return NextResponse.json(fallbackImportedDraft(source, payload));
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
}
