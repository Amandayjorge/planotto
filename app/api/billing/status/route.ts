import { NextResponse } from "next/server";
import { isStripeConfigured } from "../../../lib/stripeServer";
import {
  getSupabaseServiceClient,
  isSupabaseServiceConfigured,
  resolveRequestUserIdentity,
} from "../../../lib/supabaseServer";
import { normalizePlanTier, type PlanTier } from "../../../lib/subscription";

export const runtime = "nodejs";

type BillingStatus = "inactive" | "trial" | "active" | "past_due" | "canceled";

interface BillingProfileRow {
  plan_tier: string | null;
  subscription_status: string | null;
  pro_expires_at: string | null;
  stripe_customer_id?: string | null;
}

const normalizeBillingStatus = (value: unknown): BillingStatus => {
  const status = String(value || "").trim().toLowerCase();
  if (
    status === "inactive" ||
    status === "trial" ||
    status === "active" ||
    status === "past_due" ||
    status === "canceled"
  ) {
    return status;
  }
  return "inactive";
};

const readBillingProfile = async (userId: string): Promise<{
  planTier: PlanTier;
  subscriptionStatus: BillingStatus;
  proExpiresAt: string;
  hasStripeCustomer: boolean;
}> => {
  const supabase = getSupabaseServiceClient();
  const baseSelect = "plan_tier,subscription_status,pro_expires_at,stripe_customer_id";

  const { data, error } = await supabase
    .from("user_profiles")
    .select(baseSelect)
    .eq("user_id", userId)
    .maybeSingle();

  if (!error && data) {
    const row = data as BillingProfileRow;
    return {
      planTier: normalizePlanTier(row.plan_tier),
      subscriptionStatus: normalizeBillingStatus(row.subscription_status),
      proExpiresAt: row.pro_expires_at || "",
      hasStripeCustomer: Boolean(String(row.stripe_customer_id || "").trim()),
    };
  }

  const { data: fallbackData } = await supabase
    .from("user_profiles")
    .select("plan_tier,subscription_status,pro_expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (!fallbackData) {
    return {
      planTier: "free",
      subscriptionStatus: "inactive",
      proExpiresAt: "",
      hasStripeCustomer: false,
    };
  }

  const row = fallbackData as BillingProfileRow;
  return {
    planTier: normalizePlanTier(row.plan_tier),
    subscriptionStatus: normalizeBillingStatus(row.subscription_status),
    proExpiresAt: row.pro_expires_at || "",
    hasStripeCustomer: false,
  };
};

export async function GET(request: Request) {
  try {
    if (!isSupabaseServiceConfigured()) {
      return NextResponse.json(
        {
          error: "Supabase service role is not configured.",
        },
        { status: 503 }
      );
    }

    const identity = await resolveRequestUserIdentity(request);
    if (!identity) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await readBillingProfile(identity.id);
    return NextResponse.json({
      planTier: profile.planTier,
      subscriptionStatus: profile.subscriptionStatus,
      proExpiresAt: profile.proExpiresAt,
      hasStripeCustomer: profile.hasStripeCustomer,
      billingConfigured: isStripeConfigured(),
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : "Failed to load billing status.";
    return NextResponse.json({ error: text }, { status: 500 });
  }
}

