"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

const hasValidSupabaseEnv = (url?: string, anonKey?: string): boolean => {
  const normalizedUrl = (url || "").trim();
  const normalizedKey = (anonKey || "").trim();

  if (!normalizedUrl || !normalizedKey) return false;
  if (normalizedUrl === "..." || normalizedKey === "...") return false;
  if (normalizedKey === "your_anon_key") return false;

  const isHttpUrl = /^https?:\/\//i.test(normalizedUrl);
  if (!isHttpUrl) return false;

  return normalizedKey.length > 20;
};

export const isSupabaseConfigured = (): boolean => {
  return hasValidSupabaseEnv(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
};

export const getSupabaseClient = (): SupabaseClient => {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();

  if (!hasValidSupabaseEnv(url, anonKey)) {
    throw new Error(
      "Supabase is not configured. Set valid NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  if (!client) {
    client = createClient(url, anonKey);
  }

  return client;
};
