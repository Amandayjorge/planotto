"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "./supabaseClient";
import {
  cachePlanTier,
  readCachedPlanTier,
  resolvePlanTierFromMetadata,
  type PlanTier,
} from "./subscription";

const resolveUserPlanTier = (user: User | null | undefined): PlanTier =>
  resolvePlanTierFromMetadata((user?.user_metadata || null) as Record<string, unknown> | null);

export const usePlanTier = (): { planTier: PlanTier; isPro: boolean; isResolved: boolean } => {
  const isSupabaseReady = isSupabaseConfigured();
  const [planTier, setPlanTier] = useState<PlanTier>(() => (
    isSupabaseReady ? readCachedPlanTier() : "free"
  ));
  const [isResolved, setIsResolved] = useState(!isSupabaseReady);

  useEffect(() => {
    let isCancelled = false;

    if (!isSupabaseReady) {
      cachePlanTier("free");
      return;
    }

    const applyUserPlan = (user: User | null | undefined) => {
      if (isCancelled) return;
      const resolved = resolveUserPlanTier(user);
      setPlanTier(resolved);
      cachePlanTier(resolved);
      setIsResolved(true);
    };

    const supabase = getSupabaseClient();

    supabase.auth.getUser()
      .then(({ data }) => applyUserPlan(data.user))
      .catch(() => {
        if (isCancelled) return;
        setPlanTier("free");
        cachePlanTier("free");
        setIsResolved(true);
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      applyUserPlan(session?.user);
    });

    return () => {
      isCancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, [isSupabaseReady]);

  return {
    planTier,
    isPro: planTier === "pro",
    isResolved,
  };
};
