"use client";

import { useEffect, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import {
  SHOPPING_PRINT_SNAPSHOT_KEY,
  type ShoppingPrintSnapshot,
} from "../printSnapshot";

const formatGeneratedAt = (iso: string, locale: string): string => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const localeMap: Record<string, string> = {
    ru: "ru-RU",
    en: "en-US",
    es: "es-ES",
  };
  return parsed.toLocaleString(localeMap[locale] || "en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export default function ShoppingPrintPage() {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<ShoppingPrintSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    document.body.classList.add("shopping-print-page");
    try {
      const raw = window.sessionStorage.getItem(SHOPPING_PRINT_SNAPSHOT_KEY);
      if (raw) {
        setSnapshot(JSON.parse(raw) as ShoppingPrintSnapshot);
      }
    } catch {
      setSnapshot(null);
    } finally {
      setLoaded(true);
    }

    return () => {
      document.body.classList.remove("shopping-print-page");
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!loaded || !snapshot) return;
    const timer = window.setTimeout(() => {
      window.print();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loaded, snapshot]);

  if (!loaded) {
    return <section className="shopping-print shopping-print-page-marker" />;
  }

  if (!snapshot || !Array.isArray(snapshot.sections) || snapshot.sections.length === 0) {
    return (
      <section className="shopping-print shopping-print-page-marker">
        <h1 className="shopping-print__title">{t("shopping.print.title")}</h1>
        <p className="shopping-print__muted">{t("shopping.print.empty")}</p>
      </section>
    );
  }

  const generatedAt = formatGeneratedAt(snapshot.generatedAt, locale);

  return (
    <section className="shopping-print shopping-print-page-marker">
      <h1 className="shopping-print__title">{snapshot.title || t("shopping.print.title")}</h1>
      <div className="shopping-print__meta">
        <div>
          <strong>{t("shopping.print.period")}:</strong> {snapshot.periodLabel || t("shopping.period.full")}
        </div>
        <div>
          <strong>{t("shopping.print.source")}:</strong> {snapshot.sourceLabel || "—"}
        </div>
        {generatedAt ? (
          <div>
            <strong>{t("shopping.print.generated")}:</strong> {generatedAt}
          </div>
        ) : null}
      </div>

      {snapshot.sections.map((section) => (
        <section key={section.id} className="shopping-print__section">
          <h2 className="shopping-print__section-title">{section.title}</h2>
          <ul className="shopping-print__list">
            {section.items.map((item) => (
              <li key={item.id} className={`shopping-print__item ${item.purchased ? "shopping-print__item--done" : ""}`}>
                <input
                  type="checkbox"
                  checked={item.purchased}
                  readOnly
                  aria-label={item.name}
                  className="shopping-print__checkbox"
                />
                <span className="shopping-print__name">{item.name}</span>
                <span className="shopping-print__amount">{item.amountLabel}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
