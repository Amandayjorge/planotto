 "use strict";

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { fal } = require("@fal-ai/client");

const ENV_FILE_PATH = path.resolve(process.cwd(), process.env.ENV_PATH || ".env");
require("dotenv").config({ path: ENV_FILE_PATH, override: true });

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const BUCKET_NAME = (process.env.SUPABASE_RECIPE_BUCKET || "recipes").trim();
const STORAGE_FOLDER = (process.env.SUPABASE_RECIPE_FOLDER || "recipes").trim();
const RATE_LIMIT_MS = Number(process.env.IMAGE_RATE_LIMIT_MS || 1500);
const MAX_RETRIES = Number(process.env.IMAGE_MAX_RETRIES || 3);
const ERROR_FILE = process.env.IMAGE_ERROR_FILE || "errors.json";
const OVERWRITE_EXISTING = (process.env.OVERWRITE_EXISTING || "false").trim().toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "false").trim().toLowerCase() === "true";
const BUCKET_PUBLIC = (process.env.SUPABASE_BUCKET_PUBLIC || "true").trim().toLowerCase() === "true";
const parsePositiveIntEnv = (raw, fallback) => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const FAL_IMAGE_ENDPOINT_RAW = (
  process.env.FAL_IMAGE_ENDPOINT || "https://queue.fal.run/fal-ai/flux/schnell"
).trim();
const PLANOTTO_AUTHOR_ID = (process.env.PLANOTTO_AUTHOR_ID || "system").trim();
const FAL_KEY = (
  process.env.FAL_KEY ||
  process.env.Fal_KEY ||
  process.env.FAL_API_KEY ||
  process.env.FAL_TOKEN ||
  ""
).trim();
const POLL_ATTEMPTS = parsePositiveIntEnv(process.env.FAL_IMAGE_POLL_ATTEMPTS, 45);
const POLL_DELAY_MS = parsePositiveIntEnv(process.env.FAL_IMAGE_POLL_DELAY_MS, 1500);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in .env");
  process.exit(1);
}

if (!BUCKET_NAME) {
  console.error("SUPABASE_RECIPE_BUCKET must point to an existing Supabase Storage bucket.");
  process.exit(1);
}

if (!FAL_KEY) {
  console.error("FAL_KEY / FAL_API_KEY is required to generate images.");
  process.exit(1);
}

const normalizeFalEndpoint = (rawValue) => {
  const value = (rawValue || "").trim();
  if (!value) return { url: null, id: null };
  if (/^https?:\/\//i.test(value)) return { url: value, id: null };
  if (/^queue\.fal\.run\//i.test(value)) return { url: `https://${value}`, id: null };
  return { url: null, id: value.replace(/^\/+/g, "") };
};
const isQueueFalUrl = (url) => /^https?:\/\/queue\.fal\.run\//i.test(url || "");
const toDirectFalUrl = (url) => (isQueueFalUrl(url) ? url.replace(/^https?:\/\/queue\.fal\.run\//i, "https://fal.run/") : url);

const { url: FAL_ENDPOINT_URL, id: FAL_ENDPOINT_ID } = normalizeFalEndpoint(FAL_IMAGE_ENDPOINT_RAW);
if (!FAL_ENDPOINT_URL && !FAL_ENDPOINT_ID) {
  console.error("FAL_IMAGE_ENDPOINT must be either a URL (starts with http) or an endpoint identifier.");
  process.exit(1);
}

fal.config({ credentials: FAL_KEY });

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const STORAGE_CONTRACT = "recipes.image stores a Supabase storage path (bucket-relative).";

const buildPrompt = ({ title, description, ingredients }) => {
  const ingredientList = (Array.isArray(ingredients) ? ingredients : []).map((item) => {
    if (!item) return "";
    if (typeof item === "string") return item;
    return (item.name || "").toString();
  });
  const trimmedIngredients = ingredientList.filter(Boolean).slice(0, 5).join(", ");
  const coreTitle = (title || "homecooked dish").trim() || "homecooked dish";
  const chunks = [
    `realistic home-cooked ${coreTitle}`,
    trimmedIngredients ? `ingredients: ${trimmedIngredients}` : "",
    "close-up food photography, plated, natural lighting, neutral background",
    "no people, no logos, no text, no watermark",
  ];
  return chunks.filter(Boolean).join(", ");
};

const extractFalImageUrl = (payload) => {
  if (!payload) return "";
  if (typeof payload === "string") return payload.startsWith("http") ? payload : "";
  if (Array.isArray(payload)) {
    for (const candidate of payload) {
      const found = extractFalImageUrl(candidate);
      if (found) return found;
    }
    return "";
  }
  if (typeof payload === "object") {
    const record = payload;
    const keys = ["url", "imageUrl", "contentUrl", "image", "images", "output", "result", "data", "response"];
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.startsWith("http")) return value;
      const nested = extractFalImageUrl(value);
      if (nested) return nested;
    }
  }
  return "";
};

const safeString = (value) => (typeof value === "string" ? value.trim() : "");

const buildFalInputVariants = (prompt) => {
  const text = (prompt || "").trim();
  return [
    { prompt: text, image_size: "square_hd", num_images: 1 },
    { prompt: text, image_size: "square_hd" },
    { prompt: text, size: "1024x1024", num_images: 1 },
    { prompt: text, size: "1024x1024" },
    { prompt: text, num_images: 1 },
    { prompt: text },
  ];
};

const extractFalErrorDetail = (payload) => {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const text = extractFalErrorDetail(item);
      if (text) return text;
    }
    return "";
  }
  if (typeof payload === "object") {
    const record = payload;
    const candidates = [
      record.detail,
      record.message,
      record.msg,
      record.error,
      record.reason,
      record.hint,
      record.errors,
      record.validation_errors,
    ];
    for (const candidate of candidates) {
      const text = extractFalErrorDetail(candidate);
      if (text) return text;
    }
  }
  return "";
};

const formatFalStatusError = (status, payload) => {
  const detail = extractFalErrorDetail(payload);
  return detail ? `Fal.ai responded with status ${status}: ${detail}` : `Fal.ai responded with status ${status}`;
};

const falHeaders = (key, mode) => ({
  Authorization: `${mode} ${key}`,
  "Content-Type": "application/json",
});

const falFetch = async (url, options, key) => {
  const call = async (mode) => {
    const response = await fetch(url, {
      method: options.method,
      headers: falHeaders(key, mode),
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  };
  const first = await call("Key");
  if (first.ok || (first.status !== 401 && first.status !== 403)) return first;
  return call("Bearer");
};

const unwrapFalPayload = (payload) => payload.response ?? payload.output ?? payload.result ?? payload;

const pollFalQueuePayload = async ({ statusUrl, responseUrl, attempts, delayMs }) => {
  let latestResponseUrl = responseUrl;
  let sawCompleted = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pollTarget = statusUrl || latestResponseUrl;
    if (!pollTarget) break;

    const poll = await falFetch(pollTarget, { method: "GET" }, FAL_KEY);
    if (!poll.ok && poll.status !== 202) {
      throw new Error(formatFalStatusError(poll.status, poll.json));
    }
    if (poll.ok) {
      const statusData = poll.json && typeof poll.json === "object" ? poll.json : {};
      const candidateResponseUrl = safeString(statusData.response_url);
      if (candidateResponseUrl) {
        latestResponseUrl = candidateResponseUrl;
      }

      const pollStatus = String(statusData.status || "").toUpperCase();
      if (pollStatus === "FAILED" || pollStatus === "ERROR") {
        throw new Error(formatFalStatusError(poll.status || 500, poll.json));
      }

      if (!pollStatus || pollStatus === "COMPLETED" || pollStatus === "DONE") {
        sawCompleted = true;
        if (!statusUrl || !latestResponseUrl || pollTarget === latestResponseUrl) {
          return unwrapFalPayload(statusData);
        }

        const finalResult = await falFetch(latestResponseUrl, { method: "GET" }, FAL_KEY);
        if (!finalResult.ok && finalResult.status !== 202) {
          throw new Error(formatFalStatusError(finalResult.status, finalResult.json));
        }
        if (finalResult.ok) {
          const finalData = finalResult.json && typeof finalResult.json === "object" ? finalResult.json : {};
          return unwrapFalPayload(finalData);
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (sawCompleted && latestResponseUrl) {
    const finalResult = await falFetch(latestResponseUrl, { method: "GET" }, FAL_KEY);
    if (!finalResult.ok && finalResult.status !== 202) {
      throw new Error(formatFalStatusError(finalResult.status, finalResult.json));
    }
    if (finalResult.ok) {
      const finalData = finalResult.json && typeof finalResult.json === "object" ? finalResult.json : {};
      return unwrapFalPayload(finalData);
    }
  }

  return null;
};

const generateFalImage = async (prompt) => {
  if (FAL_ENDPOINT_URL) {
    const endpointCandidates = isQueueFalUrl(FAL_ENDPOINT_URL)
      ? [toDirectFalUrl(FAL_ENDPOINT_URL), FAL_ENDPOINT_URL]
      : [FAL_ENDPOINT_URL];
    const variants = buildFalInputVariants(prompt);
    let lastValidationError = null;
    for (const endpointUrl of endpointCandidates) {
      const queueMode = isQueueFalUrl(endpointUrl);
      for (const input of variants) {
        const enqueue = await falFetch(
          endpointUrl,
          { method: "POST", body: queueMode ? { input } : input },
          FAL_KEY
        );
        if (!enqueue.ok) {
          if (enqueue.status === 422) {
            lastValidationError = enqueue;
            continue;
          }
          throw new Error(formatFalStatusError(enqueue.status, enqueue.json));
        }
        const immediate = extractFalImageUrl(enqueue.json);
        if (immediate) return immediate;
        if (!queueMode) continue;

        const enqueueJson = enqueue.json && typeof enqueue.json === "object" ? enqueue.json : {};
        const statusUrl = safeString(enqueueJson.status_url);
        const responseUrl = safeString(enqueueJson.response_url);
        if (!statusUrl && !responseUrl) throw new Error("Fal.ai did not provide a poll URL");
        const payload = await pollFalQueuePayload({
          statusUrl,
          responseUrl,
          attempts: POLL_ATTEMPTS,
          delayMs: POLL_DELAY_MS,
        });
        const resolved = extractFalImageUrl(payload);
        if (resolved) return resolved;
      }
    }
    if (lastValidationError) {
      throw new Error(formatFalStatusError(lastValidationError.status, lastValidationError.json));
    }
    throw new Error("Fal.ai rejected image generation request.");
  }

  if (!FAL_ENDPOINT_ID) {
    throw new Error("Fal.ai endpoint identifier is missing.");
  }

  let lastError = null;
  for (const input of buildFalInputVariants(prompt)) {
    try {
      const subscription = await fal.subscribe(FAL_ENDPOINT_ID, {
        input,
        logs: false,
      });
      const images = Array.isArray(subscription?.data?.images)
        ? subscription.data.images
        : subscription?.data?.image
        ? [subscription.data.image]
        : [];
      if (images.length === 0) {
        throw new Error("Fal.ai response did not contain generated images.");
      }
      const imageUrl = images[0]?.url || images[0]?.data?.[0]?.url || "";
      if (!imageUrl) {
        throw new Error("Fal.ai response image URL is empty.");
      }
      return imageUrl;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      lastError = error;
      if (!message.includes("422")) break;
    }
  }
  throw lastError || new Error("Fal.ai endpoint identifier request failed.");
};

const downloadImageBuffer = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download generated image (${response.status})`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

const normalizeStorageKey = (recipeId) => {
  const folder = (STORAGE_FOLDER || "").replace(/^\/+/g, "").replace(/\/+$/g, "");
  return `${folder}/${recipeId}.jpg`;
};

const uploadImageToStorage = async (recipeId, buffer) => {
  const filePath = normalizeStorageKey(recipeId);
  const { error } = await supabase.storage.from(BUCKET_NAME).upload(filePath, buffer, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) throw ensureUpdatePermission(error);
  return filePath;
};

const ensureUpdatePermission = (error) => {
  const message = String((error && error.message) || "").toLowerCase();
  const code = Number((error && error.code) || 0);
  if (code === 403 || message.includes("not authorized") || message.includes("rls") || message.includes("permission")) {
    throw new Error(`Write blocked: ${message}. Use a Supabase service role key with write access.`);
  }
  return error;
};

const shouldGenerate = (recipe) => {
  const hasImage = recipe.image && recipe.image.trim().length > 0;
  return !hasImage || OVERWRITE_EXISTING;
};

const SEED_RECIPE_IDS = [
  "seed-omelet-vegetables",
  "seed-oatmeal-fruits",
  "seed-chicken-rice",
  "seed-baked-fish-potatoes",
  "seed-pasta-tomato",
  "seed-tuna-salad",
  "seed-oladi-kefir",
  "seed-greek-yogurt-granola",
  "seed-buckwheat-mushrooms",
  "seed-mashed-potatoes",
  "seed-vegetable-soup",
  "seed-fried-rice-egg",
  "seed-turkey-sandwich",
  "seed-cottage-cheese-berries",
  "seed-roasted-vegetables",
  "seed-lentil-soup",
  "seed-chicken-noodle-soup",
  "seed-rice-vegetables",
  "seed-crepes-milk",
  "seed-tuna-pasta-creamy",
];

const fetchRecipesWithoutImages = async () => {
  const { data, error } = await supabase
    .from("recipes")
    .select("id,title,short_description,description,ingredients,image,is_official")
    .or("image.eq.\"\",image.is.null")
    .eq("is_official", true)
    .limit(200)
    .order("created_at", { ascending: true });
  if (error) {
    const message = String((error && error.message) || "").toLowerCase();
    if (message.includes("is_official")) {
      throw new Error(
        "Column recipes.is_official missing. Apply the SQL migration before running the script."
      );
    }
    throw ensureUpdatePermission(error);
  }
  return (data || []).filter((recipe) => !recipe.image || recipe.image.trim() === "");
};

const logError = (recipeId, error) => {
  const entries = fs.existsSync(ERROR_FILE)
    ? JSON.parse(fs.readFileSync(ERROR_FILE, "utf-8"))
    : [];
  entries.push({
    at: new Date().toISOString(),
    recipeId,
    endpoint: FAL_IMAGE_ENDPOINT_RAW,
    error: error && error.message ? error.message : String(error),
  });
  fs.writeFileSync(ERROR_FILE, JSON.stringify(entries, null, 2));
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureAccessibility = async (recipeId, storagePath) => {
  if (DRY_RUN) return;
  if (BUCKET_PUBLIC) {
    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
    if (!data.publicUrl) {
      console.warn(`Warning: bucket marked public but failed to read public URL for ${storagePath}`);
    } else {
      const response = await fetch(data.publicUrl);
      if (!response.ok) {
        console.warn(`Public URL check failed (${response.status}) for ${data.publicUrl}`);
      }
    }
  } else {
    const { data } = await supabase.storage.from(BUCKET_NAME).createSignedUrl(storagePath, 60);
    if (!data.signedUrl) {
      console.warn(`Could not generate signed URL for ${storagePath}; UI needs server-side signed URLs.`);
    }
  }
};

const main = async () => {
  console.log("Contract:", STORAGE_CONTRACT);
  console.log("Dry run:", DRY_RUN);
  console.log("Bucket public?", BUCKET_PUBLIC);
  const recipes = await fetchRecipesWithoutImages();
  console.log(`Found ${recipes.length} candidate recipes without images.`);
  let processed = 0;
  let successes = 0;
  let failures = 0;
  for (let index = 0; index < recipes.length; index += 1) {
    const recipe = recipes[index];
    const label = recipe.title || recipe.short_description || recipe.id;
    if (!shouldGenerate(recipe)) {
      console.log(`[${index + 1}/${recipes.length}] Skipping ${label} (image already set).`);
      continue;
    }
    processed += 1;
    console.log(`[${index + 1}/${recipes.length}] Generating image for ${label}`);
    let succeeded = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const prompt = buildPrompt({
          title: recipe.title,
          description: recipe.short_description || recipe.description,
          ingredients: recipe.ingredients || [],
        });
        const generatedUrl = await generateFalImage(prompt);
        const buffer = await downloadImageBuffer(generatedUrl);
        const storagePath = await uploadImageToStorage(recipe.id, buffer);
        if (!DRY_RUN) {
          const payload = { image: storagePath };
          const { error } = await supabase.from("recipes").update(payload).eq("id", recipe.id);
          if (error) throw ensureUpdatePermission(error);
        }
        await ensureAccessibility(recipe.id, storagePath);
        console.log(`✅ [${index + 1}/${recipes.length}] Saved image path for ${label}: ${storagePath}`);
        successes += 1;
        succeeded = true;
        break;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn(`Attempt ${attempt} failed for ${label}: ${message}`);
        if (attempt === MAX_RETRIES) {
          logError(recipe.id, error);
          failures += 1;
        } else {
          console.log(`Retrying after ${RATE_LIMIT_MS}ms...`);
          await delay(RATE_LIMIT_MS);
        }
      }
    }
    if (!succeeded) {
      console.log(`[${index + 1}/${recipes.length}] Failed to produce image for ${label} after ${MAX_RETRIES} attempts.`);
    }
    await delay(RATE_LIMIT_MS);
  }
  console.log("Batch summary:");
  console.log(`  Processed candidates: ${processed}`);
  console.log(`  Successful writes : ${successes}`);
  console.log(`  Errors logged     : ${failures} (see ${ERROR_FILE})`);
};

main().catch((error) => {
  console.error("Image generation job failed:", error);
  process.exit(1);
});
