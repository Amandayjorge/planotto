import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  getStripeClient,
  getStripePriceIdPro,
  isStripeConfigured,
  normalizeRelativePath,
  resolveAppUrl,
} from "../../../lib/stripeServer";
import {
  getSupabaseServiceClient,
  isSupabaseServiceConfigured,
  resolveRequestUserIdentity,
} from "../../../lib/supabaseServer";

export const runtime = "nodejs";

interface CheckoutRequestBody {
  successPath?: string;
  cancelPath?: string;
}

interface UserBillingProfileRow {
  user_id: string;
  email: string;
  stripe_customer_id?: string | null;
}

const parseBody = async (request: Request): Promise<CheckoutRequestBody> => {
  try {
    const body = (await request.json()) as CheckoutRequestBody;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
};

const ensureProfileExists = async (userId: string, email: string): Promise<void> => {
  const supabase = getSupabaseServiceClient();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  await supabase
    .from("user_profiles")
    .upsert(
      {
        user_id: userId,
        email: normalizedEmail,
      },
      { onConflict: "user_id" }
    );
};

const readBillingProfile = async (userId: string): Promise<UserBillingProfileRow | null> => {
  const supabase = getSupabaseServiceClient();
  const { data } = await supabase
    .from("user_profiles")
    .select("user_id,email,stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (data) {
    return data as UserBillingProfileRow;
  }

  const { data: fallbackData } = await supabase
    .from("user_profiles")
    .select("user_id,email")
    .eq("user_id", userId)
    .maybeSingle();

  return (fallbackData as UserBillingProfileRow | null) || null;
};

const saveStripeCustomerId = async (userId: string, customerId: string): Promise<void> => {
  const supabase = getSupabaseServiceClient();
  const { error } = await supabase
    .from("user_profiles")
    .update({ stripe_customer_id: customerId })
    .eq("user_id", userId);
  if (error) {
    // Keep flow working even if DB schema wasn't updated yet.
    return;
  }
};

const resolveCustomerId = async ({
  userId,
  email,
  profile,
  stripe,
}: {
  userId: string;
  email: string;
  profile: UserBillingProfileRow | null;
  stripe: Stripe;
}): Promise<string> => {
  const existing = String(profile?.stripe_customer_id || "").trim();
  if (existing) return existing;

  const customer = await stripe.customers.create({
    email,
    metadata: {
      supabase_user_id: userId,
    },
  });
  const customerId = String(customer.id || "").trim();
  if (customerId) {
    await saveStripeCustomerId(userId, customerId);
  }
  return customerId;
};

export async function POST(request: Request) {
  try {
    if (!isSupabaseServiceConfigured()) {
      return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 503 });
    }

    if (!isStripeConfigured()) {
      return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
    }

    const identity = await resolveRequestUserIdentity(request);
    if (!identity) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureProfileExists(identity.id, identity.email);
    const profile = await readBillingProfile(identity.id);

    const stripe = getStripeClient();
    const customerId = await resolveCustomerId({
      userId: identity.id,
      email: profile?.email || identity.email,
      profile,
      stripe,
    });
    const body = await parseBody(request);
    const appUrl = resolveAppUrl(request);
    const successPath = normalizeRelativePath(body.successPath, "/auth?billing=success");
    const cancelPath = normalizeRelativePath(body.cancelPath, "/auth?billing=cancel");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId || undefined,
      customer_email: customerId ? undefined : identity.email,
      client_reference_id: identity.id,
      metadata: {
        supabase_user_id: identity.id,
      },
      line_items: [
        {
          price: getStripePriceIdPro(),
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      success_url: `${appUrl}${successPath}`,
      cancel_url: `${appUrl}${cancelPath}`,
    });

    if (!session.url) {
      return NextResponse.json({ error: "Stripe checkout URL is missing." }, { status: 500 });
    }

    return NextResponse.json({ url: session.url });
  } catch (error) {
    const text = error instanceof Error ? error.message : "Failed to create checkout session.";
    return NextResponse.json({ error: text }, { status: 500 });
  }
}

