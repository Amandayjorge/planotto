import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface RequestUserIdentity {
  id: string;
  email: string;
}

let serviceClient: SupabaseClient | null = null;

const readSupabaseServiceEnv = (): {
  url: string;
  serviceRoleKey: string;
} => ({
  url: String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim(),
  serviceRoleKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
});

export const isSupabaseServiceConfigured = (): boolean => {
  const env = readSupabaseServiceEnv();
  if (!env.url || !env.serviceRoleKey) return false;
  if (!/^https?:\/\//i.test(env.url)) return false;
  if (env.serviceRoleKey.length < 20) return false;
  return true;
};

export const getSupabaseServiceClient = (): SupabaseClient => {
  if (serviceClient) return serviceClient;
  const env = readSupabaseServiceEnv();
  if (!isSupabaseServiceConfigured()) {
    throw new Error("Supabase service role is not configured.");
  }
  serviceClient = createClient(env.url, env.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return serviceClient;
};

export const extractBearerToken = (request: Request): string | null => {
  const authHeader = String(request.headers.get("authorization") || "").trim();
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = String(match[1] || "").trim();
  return token || null;
};

export const resolveRequestUserIdentity = async (
  request: Request
): Promise<RequestUserIdentity | null> => {
  const token = extractBearerToken(request);
  if (!token) return null;

  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const email = String(data.user.email || "").trim().toLowerCase();
  if (!email) return null;

  return {
    id: data.user.id,
    email,
  };
};

