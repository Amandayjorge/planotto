import { NextResponse } from "next/server";
import {
  getStripeClient,
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

interface PortalRequestBody {
  returnPath?: string;
}

const parseBody = async (request: Request): Promise<PortalRequestBody> => {
  try {
    const body = (await request.json()) as PortalRequestBody;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
};

const readStripeCustomerId = async (userId: string): Promise<string> => {
  const supabase = getSupabaseServiceClient();
  const { data } = await supabase
    .from("user_profiles")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return "";
  return String((data as { stripe_customer_id?: unknown }).stripe_customer_id || "").trim();
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

    const customerId = await readStripeCustomerId(identity.id);
    if (!customerId) {
      return NextResponse.json(
        { error: "Stripe customer is missing. Activate Pro first." },
        { status: 400 }
      );
    }

    const body = await parseBody(request);
    const returnPath = normalizeRelativePath(body.returnPath, "/auth");
    const appUrl = resolveAppUrl(request);
    const stripe = getStripeClient();

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}${returnPath}`,
    });

    if (!session.url) {
      return NextResponse.json({ error: "Stripe portal URL is missing." }, { status: 500 });
    }

    return NextResponse.json({ url: session.url });
  } catch (error) {
    const text = error instanceof Error ? error.message : "Failed to create billing portal session.";
    return NextResponse.json({ error: text }, { status: 500 });
  }
}

