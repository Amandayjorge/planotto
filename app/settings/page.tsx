"use client";

import Link from "next/link";
import { useState } from "react";

const RANGE_STATE_KEY = "selectedMenuRange";
const WEEK_START_KEY = "selectedWeekStart";
const ACTIVE_PRODUCTS_KEY_PREFIX = "activeProducts";

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const formatDate = (date: Date): string => date.toISOString().split("T")[0];

const getCurrentRangeKey = (): string => {
  if (typeof window === "undefined") {
    const start = formatDate(getMonday(new Date()));
    const end = formatDate(addDays(new Date(start), 6));
    return `${start}__${end}`;
  }

  try {
    const raw = localStorage.getItem(RANGE_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { start?: string; end?: string };
      if (isIsoDate(String(parsed.start || "")) && isIsoDate(String(parsed.end || ""))) {
        return `${parsed.start}__${parsed.end}`;
      }
    }
  } catch {
    // ignore parse errors
  }

  const fallbackStartRaw = localStorage.getItem(WEEK_START_KEY) || "";
  const startIso = isIsoDate(fallbackStartRaw) ? fallbackStartRaw : formatDate(getMonday(new Date()));
  const endIso = formatDate(addDays(new Date(startIso), 6));
  return `${startIso}__${endIso}`;
};

const getActiveProductsCount = (rangeKey: string): number => {
  if (typeof window === "undefined" || !rangeKey) return 0;
  try {
    const raw = localStorage.getItem(`${ACTIVE_PRODUCTS_KEY_PREFIX}:${rangeKey}`);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 0;
    return parsed.filter(
      (item) => item && typeof item === "object" && typeof item.name === "string" && item.name.trim()
    ).length;
  } catch {
    return 0;
  }
};

export default function SettingsPage() {
  const [activeProductsCount] = useState(() => {
    if (typeof window === "undefined") return 0;
    return getActiveProductsCount(getCurrentRangeKey());
  });

  return (
    <section className="card">
      <h1 className="h1">Настройки</h1>

      <div className="card" style={{ marginTop: "12px", padding: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>Активные продукты</h2>
        <p className="muted" style={{ marginTop: "6px", marginBottom: "10px" }}>
          Активных продуктов: {activeProductsCount}
        </p>
        <Link href="/priority-products" className="btn">
          Открыть
        </Link>
      </div>

      <div style={{ marginTop: "12px" }}>
        <Link href="/menu" className="btn">
          ← Назад в меню
        </Link>
      </div>
    </section>
  );
}
