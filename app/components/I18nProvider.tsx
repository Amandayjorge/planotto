"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSupabaseClient, isSupabaseConfigured } from "../lib/supabaseClient";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  PROFILE_LOCALE_FIELD,
  SUPPORTED_LOCALES,
  type Locale,
  isLocale,
  translate,
} from "../lib/i18n";

interface I18nContextValue {
  locale: Locale;
  locales: readonly Locale[];
  setLocale: (nextLocale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const readUserLocale = (metadata: unknown): Locale | null => {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[PROFILE_LOCALE_FIELD];
  return isLocale(raw) ? raw : null;
};

const persistLocale = (locale: Locale) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  });

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    persistLocale(nextLocale);
  }, []);

  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const supabase = getSupabaseClient();
    let active = true;

    const applyLocaleFromUser = (metadata: unknown) => {
      const userLocale = readUserLocale(metadata);
      if (!userLocale) return;
      setLocaleState((current) => (current === userLocale ? current : userLocale));
      persistLocale(userLocale);
    };

    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      applyLocaleFromUser(data.user?.user_metadata);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      applyLocaleFromUser(session?.user?.user_metadata);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      locales: SUPPORTED_LOCALES,
      setLocale,
      t: (key: string, params?: Record<string, string | number>) =>
        translate(locale, key, params),
    }),
    [locale, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = (): I18nContextValue => {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
};
