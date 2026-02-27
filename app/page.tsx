"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import Link from "next/link";
import { useI18n } from "./components/I18nProvider";
import {
  getPrimaryRouteByProfileGoal,
  readProfileGoalFromStorage,
  type ProfileGoal,
} from "./lib/profileGoal";

const RECIPES_STORAGE_KEY = "recipes";
const MENU_STORAGE_PREFIX = "weeklyMenu:";
const RANGE_STATE_KEY = "selectedMenuRange";
const WEEK_START_KEY = "selectedWeekStart";

interface StoredRangeState {
  start?: string;
  end?: string;
}

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

const getMondayIso = (date: Date): string => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split("T")[0];
};

const parseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const menuSnapshotHasItems = (raw: string | null): boolean => {
  const parsed = parseJson<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object") return false;

  return Object.values(parsed).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value && typeof value === "object");
  });
};

const hasAnyMenuSnapshots = (): boolean => {
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(MENU_STORAGE_PREFIX)) continue;
    if (menuSnapshotHasItems(localStorage.getItem(key))) return true;
  }
  return false;
};

const hasCurrentPeriodMenu = (): boolean => {
  const rangeState = parseJson<StoredRangeState>(localStorage.getItem(RANGE_STATE_KEY));
  const rangeStart = typeof rangeState?.start === "string" ? rangeState.start : "";
  const rangeEnd = typeof rangeState?.end === "string" ? rangeState.end : "";

  if (isIsoDate(rangeStart) && isIsoDate(rangeEnd)) {
    const rangeKey = `${rangeStart}__${rangeEnd}`;
    if (menuSnapshotHasItems(localStorage.getItem(`${MENU_STORAGE_PREFIX}${rangeKey}`))) {
      return true;
    }
  }

  const storedWeekStart = localStorage.getItem(WEEK_START_KEY) || "";
  if (isIsoDate(storedWeekStart) && menuSnapshotHasItems(localStorage.getItem(`${MENU_STORAGE_PREFIX}${storedWeekStart}`))) {
    return true;
  }

  const currentMonday = getMondayIso(new Date());
  if (menuSnapshotHasItems(localStorage.getItem(`${MENU_STORAGE_PREFIX}${currentMonday}`))) {
    return true;
  }

  return false;
};

const hasRecipes = (): boolean => {
  const parsed = parseJson<unknown[]>(localStorage.getItem(RECIPES_STORAGE_KEY));
  return Array.isArray(parsed) && parsed.length > 0;
};

const hasStartedPlanning = (): boolean => {
  return hasRecipes() || hasCurrentPeriodMenu() || hasAnyMenuSnapshots();
};

export default function Home() {
  const { t } = useI18n();
  const [profileGoal, setProfileGoal] = useState<ProfileGoal>("menu");
  const startedPlanning = useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined") return () => undefined;

      const handleStorage = () => onStoreChange();
      const handleFocus = () => onStoreChange();
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") onStoreChange();
      };

      window.addEventListener("storage", handleStorage);
      window.addEventListener("focus", handleFocus);
      document.addEventListener("visibilitychange", handleVisibilityChange);

      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener("focus", handleFocus);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      };
    },
    () => {
      if (typeof window === "undefined") return false;
      return hasStartedPlanning();
    },
    () => false
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshProfileGoal = () => setProfileGoal(readProfileGoalFromStorage());
    refreshProfileGoal();
    window.addEventListener("storage", refreshProfileGoal);
    window.addEventListener("focus", refreshProfileGoal);
    return () => {
      window.removeEventListener("storage", refreshProfileGoal);
      window.removeEventListener("focus", refreshProfileGoal);
    };
  }, []);

  const primaryGoalRoute = getPrimaryRouteByProfileGoal(profileGoal);
  const primaryCtaHref =
    startedPlanning ? primaryGoalRoute : profileGoal === "menu" ? "/menu?first=1" : primaryGoalRoute;
  const primaryCtaText = startedPlanning
    ? t("home.cta.continue")
    : t("home.cta.start");

  return (
    <section className="home card">
      <div className="home-hero">
        <div className="home-hero__text">
          <h1 className="home-hero__title">{t("home.title")}</h1>
          <p className="home-hero__description">{t("home.description")}</p>

          <div className="home-hero__actions">
            <Link className="btn btn-primary" href={primaryCtaHref}>
              {primaryCtaText}
            </Link>
          </div>

          <Link className="home-hero__how-link" href="#how-it-works">
            {t("home.howLink")}
          </Link>
        </div>

        <div className="home-hero__media">
          <div className="home-hero__image-wrap">
            <Image
              src="/mascot/pages/home.png"
              alt={t("home.example.mascotAlt")}
              width={520}
              height={520}
              priority
              className="home-hero__image"
            />
          </div>
        </div>
      </div>

      <div id="how-it-works" className="home-flow">
        <h2 className="home-flow__title">{t("home.how.title")}</h2>
        <div className="home-flow__steps">
          <article className="home-flow__step">
            <div className="home-flow__step-num">1</div>
            <h3>{t("home.how.step1.title")}</h3>
            <p>{t("home.how.step1.description")}</p>
          </article>
          <article className="home-flow__step">
            <div className="home-flow__step-num">2</div>
            <h3>{t("home.how.step2.title")}</h3>
            <p>{t("home.how.step2.description")}</p>
          </article>
          <article className="home-flow__step">
            <div className="home-flow__step-num">3</div>
            <h3>{t("home.how.step3.title")}</h3>
            <p>{t("home.how.step3.description")}</p>
          </article>
        </div>
      </div>

      <div className="home-example">
        <h2 className="home-example__title">{t("home.example.title")}</h2>
        <div className="home-example__grid">
          <article className="home-example__card">
            <div className="home-example__label">{t("home.example.dinnerLabel")}</div>
            <div className="home-example__value">{t("home.example.dinnerValue")}</div>
          </article>
          <article className="home-example__card">
            <div className="home-example__label">{t("home.example.shoppingLabel")}</div>
            <div className="home-example__value">{t("home.example.shoppingValue")}</div>
          </article>
        </div>
      </div>
    </section>
  );
}
