"use client";

"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { PLAN_TIER_STORAGE_KEY, normalizePlanTier, type PlanTier } from "../lib/subscription";
import { usePlanTier } from "../lib/usePlanTier";

const PRO_ACTIVATION_SHOWN_KEY = "planotto:pro-activation-shown";

export default function ProActivationToast() {
  const { t } = useI18n();
  const { planTier, isResolved } = usePlanTier();
  const [isVisible, setIsVisible] = useState(false);
  const [hasShown, setHasShown] = useState(false);
  const lastTierRef = useRef<PlanTier>("free");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(PRO_ACTIVATION_SHOWN_KEY) === "1";
    const cached = normalizePlanTier(window.localStorage.getItem(PLAN_TIER_STORAGE_KEY) || "free");
    const timerId = window.setTimeout(() => setHasShown(stored), 0);
    lastTierRef.current = cached;
    return () => window.clearTimeout(timerId);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isResolved) return;

    const previousTier = lastTierRef.current;
    const canShowToast = planTier === "pro" && previousTier !== "pro" && !hasShown;
    let showTimer: number | null = null;

    if (canShowToast) {
      showTimer = window.setTimeout(() => setIsVisible(true), 0);
      window.localStorage.setItem(PRO_ACTIVATION_SHOWN_KEY, "1");
      window.setTimeout(() => setHasShown(true), 0);
      timerRef.current = window.setTimeout(() => setIsVisible(false), 35000);
    }

    if (planTier !== "pro") {
      window.localStorage.removeItem(PRO_ACTIVATION_SHOWN_KEY);
      window.setTimeout(() => {
        setHasShown(false);
        if (isVisible) {
          setIsVisible(false);
        }
      }, 0);
    }

    lastTierRef.current = planTier;

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (showTimer) {
        window.clearTimeout(showTimer);
      }
    };
  }, [hasShown, isResolved, isVisible, planTier]);

  const handleClose = () => {
    setIsVisible(false);
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PRO_ACTIVATION_SHOWN_KEY, "1");
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  if (!isVisible) return null;

  return (
    <div className="pro-activation-toast-wrapper" role="status" aria-live="polite" onClick={handleClose}>
      <div className="pro-activation-toast" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="pro-activation-toast__close" onClick={handleClose}>
          ×
        </button>
        <div className="pro-activation-toast__title">{t("subscription.proActivated.title")}</div>
        <p className="pro-activation-toast__status">{t("subscription.proActivated.status")}</p>
        <div className="pro-activation-toast__tags">
          <span className="pro-activation-toast__badge">Pro</span>
          <span className="pro-activation-toast__badge">{t("subscription.proActivated.status")}</span>
        </div>
      </div>
    </div>
  );
}
