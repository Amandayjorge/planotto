export interface RecipeShareBundleItem {
  id: string;
  token: string;
}

const MAX_BUNDLE_ITEMS = 24;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

const toBase64Url = (value: string): string => {
  const btoaFn = typeof globalThis.btoa === "function" ? globalThis.btoa.bind(globalThis) : null;
  if (!btoaFn) return "";
  const bytes = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  return btoaFn(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const fromBase64Url = (value: string): string | null => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const atobFn = typeof globalThis.atob === "function" ? globalThis.atob.bind(globalThis) : null;
  if (!atobFn) return null;
  try {
    const binary = atobFn(withPadding);
    const percentEncoded = Array.from(binary)
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    return decodeURIComponent(percentEncoded);
  } catch {
    return null;
  }
};

const normalizeBundleItems = (items: RecipeShareBundleItem[]): RecipeShareBundleItem[] => {
  const seen = new Set<string>();
  const normalized: RecipeShareBundleItem[] = [];
  items.forEach((item) => {
    const id = String(item.id || "").trim();
    const token = String(item.token || "").trim();
    if (!id || !token || !TOKEN_PATTERN.test(token)) return;
    if (seen.has(id)) return;
    seen.add(id);
    normalized.push({ id, token });
  });
  return normalized.slice(0, MAX_BUNDLE_ITEMS);
};

export const encodeRecipeShareBundle = (items: RecipeShareBundleItem[]): string => {
  const payload = normalizeBundleItems(items);
  return toBase64Url(JSON.stringify(payload));
};

export const decodeRecipeShareBundle = (raw: string): RecipeShareBundleItem[] => {
  const decoded = fromBase64Url(String(raw || "").trim());
  if (!decoded) return [];
  try {
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) return [];
    return normalizeBundleItems(
      parsed.map((item) => ({
        id: String(item?.id || ""),
        token: String(item?.token || ""),
      }))
    );
  } catch {
    return [];
  }
};
