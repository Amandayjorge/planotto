import en from "./locales/en.json";
import es from "./locales/es.json";
import ru from "./locales/ru.json";

type TranslationPrimitive = string | number | boolean | null;
type TranslationValue = TranslationPrimitive | TranslationTree;
interface TranslationTree {
  [key: string]: TranslationValue;
}

export const SUPPORTED_LOCALES = ["ru", "en", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ru";
export const LOCALE_STORAGE_KEY = "planotto:locale";
export const PROFILE_LOCALE_FIELD = "ui_language";

const dictionaries: Record<Locale, TranslationTree> = {
  ru: ru as TranslationTree,
  en: en as TranslationTree,
  es: es as TranslationTree,
};

const resolvePath = (dictionary: TranslationTree, path: string): string | null => {
  const chunks = path.split(".");
  let current: TranslationValue = dictionary;

  for (const chunk of chunks) {
    if (!current || typeof current !== "object" || !(chunk in current)) {
      return null;
    }
    current = (current as TranslationTree)[chunk];
  }

  return typeof current === "string" ? current : null;
};

const interpolate = (
  template: string,
  params?: Record<string, string | number>
): string => {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in params)) return `{{${key}}}`;
    return String(params[key]);
  });
};

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && SUPPORTED_LOCALES.includes(value as Locale);

export const translate = (
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string => {
  const localized = resolvePath(dictionaries[locale], key);
  if (localized) return interpolate(localized, params);

  const fallback = resolvePath(dictionaries[DEFAULT_LOCALE], key);
  if (fallback) return interpolate(fallback, params);

  return key;
};
