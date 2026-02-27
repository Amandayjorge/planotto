"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { PLAN_TIER_STORAGE_KEY, normalizePlanTier, type PlanTier } from "../lib/subscription";
import { usePlanTier } from "../lib/usePlanTier";

const PRO_ACTIVATION_SEEN_KEY = "planotto:pro-activation-seen";

export default function ProActivationToast() {
  const { t } = useI18n();
  const { planTier, isResolved } = usePlanTier();
  const [isVisible, setIsVisible] = useState(false);
  const lastTierRef = useRef<PlanTier>("free");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const cached = normalizePlanTier(window.localStorage.getItem(PLAN_TIER_STORAGE_KEY) || "free");
    lastTierRef.current = cached;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isResolved) return;

    const previousTier = lastTierRef.current;
    const hasSeenCurrentProToast = window.localStorage.getItem(PRO_ACTIVATION_SEEN_KEY) === "1";

    if (planTier === "pro" && previousTier !== "pro" && !hasSeenCurrentProToast && !isVisible) {
      window.setTimeout(() => setIsVisible(true), 0);
      window.localStorage.setItem(PRO_ACTIVATION_SEEN_KEY, "1");
    }

    if (planTier !== "pro") {
      window.localStorage.removeItem(PRO_ACTIVATION_SEEN_KEY);
      if (isVisible) {
        window.setTimeout(() => setIsVisible(false), 0);
      }
    }

    lastTierRef.current = planTier;
  }, [isResolved, isVisible, planTier]);

  if (!isVisible) return null;

  return (
    <div className="pro-activation-toast" role="status" aria-live="polite">
      <div className="pro-activation-toast__title">{t("subscription.proActivated.title")}</div>
      <p className="pro-activation-toast__status">{t("subscription.proActivated.status")}</p>
      <ul className="pro-activation-toast__list">
        <li>{t("subscription.proActivated.items.aiTranslation")}</li>
        <li>{t("subscription.proActivated.items.photoImport")}</li>
        <li>{t("subscription.proActivated.items.multipleMenus")}</li>
      </ul>
      <button
        type="button"
        className="btn btn-primary pro-activation-toast__action"
        onClick={() => setIsVisible(false)}
      >
        {t("subscription.proActivated.actions.ok")}
      </button>
    </div>
  );
}
