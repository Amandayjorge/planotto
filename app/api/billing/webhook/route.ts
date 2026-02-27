import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  getStripeClient,
  getStripeWebhookSecret,
  hasStripeWebhookSecret,
} from "../../../lib/stripeServer";
import {
  getSupabaseServiceClient,
  isSupabaseServiceConfigured,
} from "../../../lib/supabaseServer";
import type { PlanTier } from "../../../lib/subscription";

export const runtime = "nodejs";

type BillingStatus = "inactive" | "trial" | "active" | "past_due" | "canceled";

interface BillingProfilePatch {
  plan_tier: PlanTier;
  subscription_status: BillingStatus;
  pro_expires_at: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_price_id?: string | null;
  stripe_current_period_end?: string | null;
}

const safeString = (value: unknown): string => String(value || "").trim();

const unixToIso = (value: unknown): string | null => {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString();
};

const toBillingStatus = (stripeStatus: string): BillingStatus => {
  switch (stripeStatus) {
    case "trialing":
      return "trial";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return "canceled";
    default:
      return "inactive";
  }
};

const hasProAccess = (stripeStatus: string, periodEndUnix: number | null): boolean => {
  if (stripeStatus === "active" || stripeStatus === "trialing" || stripeStatus === "past_due") return true;
  if (stripeStatus === "canceled" && periodEndUnix && periodEndUnix > Math.floor(Date.now() / 1000)) return true;
  return false;
};

const getSubscriptionPriceId = (subscription: Stripe.Subscription): string | null => {
  const firstItem = subscription.items.data[0];
  if (!firstItem) return null;
  const priceId = safeString(firstItem.price?.id || "");
  return priceId || null;
};

const getSubscriptionPeriodEndUnix = (subscription: Stripe.Subscription): number | null => {
  const firstItem = subscription.items.data[0];
  const fromItem = Number(firstItem?.current_period_end || 0);
  if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;

  const fromCancelAt = Number(subscription.cancel_at || 0);
  if (Number.isFinite(fromCancelAt) && fromCancelAt > 0) return fromCancelAt;

  const fromTrialEnd = Number(subscription.trial_end || 0);
  if (Number.isFinite(fromTrialEnd) && fromTrialEnd > 0) return fromTrialEnd;

  return null;
};

const ensureProfileExists = async (userId: string, email: string | null): Promise<void> => {
  const normalizedUserId = safeString(userId);
  if (!normalizedUserId) return;
  const normalizedEmail = safeString(email || "").toLowerCase();
  if (!normalizedEmail) return;

  const supabase = getSupabaseServiceClient();
  await supabase
    .from("user_profiles")
    .upsert(
      {
        user_id: normalizedUserId,
        email: normalizedEmail,
      },
      { onConflict: "user_id" }
    );
};

const applyBillingPatch = async (
  userId: string,
  patch: BillingProfilePatch,
  email: string | null
): Promise<void> => {
  const normalizedUserId = safeString(userId);
  if (!normalizedUserId) return;
  await ensureProfileExists(normalizedUserId, email);

  const supabase = getSupabaseServiceClient();
  const { error } = await supabase
    .from("user_profiles")
    .update(patch)
    .eq("user_id", normalizedUserId);

  if (!error) return;

  const fallbackPatch = {
    plan_tier: patch.plan_tier,
    subscription_status: patch.subscription_status,
    pro_expires_at: patch.pro_expires_at,
  };
  const { error: fallbackError } = await supabase
    .from("user_profiles")
    .update(fallbackPatch)
    .eq("user_id", normalizedUserId);
  if (fallbackError) {
    throw fallbackError;
  }
};

const findUserIdByStripeCustomerId = async (customerId: string): Promise<string | null> => {
  const normalizedCustomerId = safeString(customerId);
  if (!normalizedCustomerId) return null;
  const supabase = getSupabaseServiceClient();
  const { data } = await supabase
    .from("user_profiles")
    .select("user_id")
    .eq("stripe_customer_id", normalizedCustomerId)
    .maybeSingle();

  if (!data) return null;
  return safeString((data as { user_id?: unknown }).user_id) || null;
};

const findUserIdByEmail = async (email: string): Promise<string | null> => {
  const normalizedEmail = safeString(email).toLowerCase();
  if (!normalizedEmail) return null;
  const supabase = getSupabaseServiceClient();
  const { data } = await supabase
    .from("user_profiles")
    .select("user_id")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (!data) return null;
  return safeString((data as { user_id?: unknown }).user_id) || null;
};

const findCustomerEmail = async (stripe: Stripe, customerId: string): Promise<string | null> => {
  const normalizedCustomerId = safeString(customerId);
  if (!normalizedCustomerId) return null;
  try {
    const customer = await stripe.customers.retrieve(normalizedCustomerId);
    if (typeof customer === "string") return null;
    const email = "email" in customer ? safeString(customer.email || "") : "";
    return email.toLowerCase() || null;
  } catch {
    return null;
  }
};

const resolveUserFromCheckoutSession = async (
  session: Stripe.Checkout.Session
): Promise<{ userId: string | null; email: string | null; customerId: string | null }> => {
  const userIdFromClientReference = safeString(session.client_reference_id);
  const userIdFromMetadata = safeString(session.metadata?.supabase_user_id);
  const customerId =
    typeof session.customer === "string" ? safeString(session.customer) : safeString(session.customer?.id);
  const email =
    safeString(session.customer_details?.email || "") ||
    safeString(session.customer_email || "");

  let userId = userIdFromClientReference || userIdFromMetadata || null;
  if (!userId && customerId) {
    userId = await findUserIdByStripeCustomerId(customerId);
  }
  if (!userId && email) {
    userId = await findUserIdByEmail(email);
  }

  return {
    userId,
    email: email ? email.toLowerCase() : null,
    customerId: customerId || null,
  };
};

const patchFromSubscription = (
  subscription: Stripe.Subscription,
  customerId: string | null,
  forceCanceled = false
): BillingProfilePatch => {
  const stripeStatus = forceCanceled ? "canceled" : safeString(subscription.status).toLowerCase();
  const currentPeriodEndUnix = getSubscriptionPeriodEndUnix(subscription);
  const hasAccess = hasProAccess(stripeStatus, currentPeriodEndUnix);
  return {
    plan_tier: hasAccess ? "pro" : "free",
    subscription_status: toBillingStatus(stripeStatus),
    pro_expires_at: unixToIso(currentPeriodEndUnix),
    stripe_customer_id: customerId,
    stripe_subscription_id: safeString(subscription.id || "") || null,
    stripe_price_id: getSubscriptionPriceId(subscription),
    stripe_current_period_end: unixToIso(currentPeriodEndUnix),
  };
};

const handleCheckoutCompleted = async (
  stripe: Stripe,
  session: Stripe.Checkout.Session
): Promise<void> => {
  const resolved = await resolveUserFromCheckoutSession(session);
  if (!resolved.userId) return;

  const subscriptionId =
    typeof session.subscription === "string"
      ? safeString(session.subscription)
      : safeString(session.subscription?.id || "");

  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const patch = patchFromSubscription(subscription, resolved.customerId);
    await applyBillingPatch(resolved.userId, patch, resolved.email);
    return;
  }

  const fallbackPatch: BillingProfilePatch = {
    plan_tier: "pro",
    subscription_status: "active",
    pro_expires_at: null,
    stripe_customer_id: resolved.customerId,
    stripe_subscription_id: null,
    stripe_price_id: null,
    stripe_current_period_end: null,
  };
  await applyBillingPatch(resolved.userId, fallbackPatch, resolved.email);
};

const resolveUserFromSubscription = async (
  stripe: Stripe,
  subscription: Stripe.Subscription
): Promise<{ userId: string | null; email: string | null; customerId: string | null }> => {
  const metadataUserId = safeString(subscription.metadata?.supabase_user_id);
  const customerId =
    typeof subscription.customer === "string"
      ? safeString(subscription.customer)
      : safeString(subscription.customer?.id);

  let userId = metadataUserId || null;
  if (!userId && customerId) {
    userId = await findUserIdByStripeCustomerId(customerId);
  }

  let email: string | null = null;
  if (customerId) {
    email = await findCustomerEmail(stripe, customerId);
  }
  if (!userId && email) {
    userId = await findUserIdByEmail(email);
  }

  return {
    userId,
    email,
    customerId: customerId || null,
  };
};

const handleSubscriptionEvent = async (
  stripe: Stripe,
  subscription: Stripe.Subscription,
  options?: { forceCanceled?: boolean }
): Promise<void> => {
  const resolved = await resolveUserFromSubscription(stripe, subscription);
  if (!resolved.userId) return;

  const patch = patchFromSubscription(subscription, resolved.customerId, Boolean(options?.forceCanceled));
  await applyBillingPatch(resolved.userId, patch, resolved.email);
};

export async function POST(request: Request) {
  try {
    if (!isSupabaseServiceConfigured()) {
      return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 503 });
    }
    if (!hasStripeWebhookSecret()) {
      return NextResponse.json({ error: "Stripe webhook is not configured." }, { status: 503 });
    }

    const signature = safeString(request.headers.get("stripe-signature") || "");
    if (!signature) {
      return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
    }

    const stripe = getStripeClient();
    const payload = await request.text();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, getStripeWebhookSecret());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Stripe webhook signature.";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(stripe, session);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionEvent(stripe, subscription);
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionEvent(stripe, subscription, { forceCanceled: true });
        break;
      }
      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    const text = error instanceof Error ? error.message : "Stripe webhook processing failed.";
    return NextResponse.json({ error: text }, { status: 500 });
  }
}
