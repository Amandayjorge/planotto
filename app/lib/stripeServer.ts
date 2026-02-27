import Stripe from "stripe";

let stripeClient: Stripe | null = null;

const normalizeUrl = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  return `https://${raw.replace(/\/+$/, "")}`;
};

const getStripeEnv = (): {
  secretKey: string;
  priceIdPro: string;
  webhookSecret: string;
} => ({
  secretKey: String(process.env.STRIPE_SECRET_KEY || "").trim(),
  priceIdPro: String(process.env.STRIPE_PRICE_ID_PRO || "").trim(),
  webhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET || "").trim(),
});

export const isStripeConfigured = (): boolean => {
  const env = getStripeEnv();
  return Boolean(env.secretKey && env.priceIdPro);
};

export const hasStripeWebhookSecret = (): boolean => {
  const env = getStripeEnv();
  return Boolean(env.secretKey && env.webhookSecret);
};

export const getStripeClient = (): Stripe => {
  if (stripeClient) return stripeClient;
  const env = getStripeEnv();
  if (!env.secretKey) {
    throw new Error("Stripe is not configured.");
  }
  stripeClient = new Stripe(env.secretKey);
  return stripeClient;
};

export const getStripePriceIdPro = (): string => {
  const env = getStripeEnv();
  if (!env.priceIdPro) {
    throw new Error("Stripe Pro price is not configured.");
  }
  return env.priceIdPro;
};

export const getStripeWebhookSecret = (): string => {
  const env = getStripeEnv();
  if (!env.webhookSecret) {
    throw new Error("Stripe webhook secret is not configured.");
  }
  return env.webhookSecret;
};

export const resolveAppUrl = (request: Request): string => {
  const explicit =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    "";
  const normalizedExplicit = normalizeUrl(explicit);
  if (normalizedExplicit) return normalizedExplicit;

  try {
    const origin = new URL(request.url).origin;
    return normalizeUrl(origin);
  } catch {
    return "http://localhost:3000";
  }
};

export const normalizeRelativePath = (value: unknown, fallbackPath: string): string => {
  const candidate = String(value || "").trim();
  if (!candidate) return fallbackPath;
  if (/^https?:\/\//i.test(candidate)) return fallbackPath;
  if (!candidate.startsWith("/")) return fallbackPath;
  return candidate;
};

