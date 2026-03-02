"use client";

import { useMemo } from "react";
import { useI18n } from "./I18nProvider";
import type { NutritionFormValues, NutritionMode } from "../lib/nutrition";

interface NutritionSectionProps {
  mode: NutritionMode;
  values: NutritionFormValues;
  onModeChange: (mode: NutritionMode) => void;
  onChange: (field: keyof NutritionFormValues, value: string) => void;
}

const MODE_OPTIONS: Array<{ value: NutritionMode; labelKey: string }> = [
  { value: "per_serving", labelKey: "recipes.new.nutrition.modePerServing" },
  { value: "per_100g", labelKey: "recipes.new.nutrition.modePer100g" },
];

const FIELD_CONFIG: Array<{ key: keyof NutritionFormValues; labelKey: string }> = [
  { key: "calories", labelKey: "recipes.new.nutrition.calories" },
  { key: "protein", labelKey: "recipes.new.nutrition.protein" },
  { key: "fat", labelKey: "recipes.new.nutrition.fat" },
  { key: "carbs", labelKey: "recipes.new.nutrition.carbs" },
];

export default function NutritionSection({ mode, values, onModeChange, onChange }: NutritionSectionProps) {
  const { t } = useI18n();
  const mappedFields = useMemo(
    () =>
      FIELD_CONFIG.map((item) => ({
        ...item,
        value: values[item.key],
        onChange: (next: string) => onChange(item.key, next),
      })),
    [values, onChange]
  );

  return (
    <div style={{ marginBottom: "16px" }}>
      <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
        {t("recipes.new.nutrition.title")}
      </label>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`btn ${mode === option.value ? "btn-primary" : "btn-outline"}`}
            onClick={() => onModeChange(option.value)}
            aria-pressed={mode === option.value}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gap: "10px",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
        }}
      >
        {mappedFields.map((field) => (
          <label key={field.key} style={{ display: "flex", flexDirection: "column", fontWeight: "600" }}>
            <span style={{ fontSize: "13px", marginBottom: "4px" }}>{t(field.labelKey)}</span>
            <input
              className="input"
              type="number"
              min="0"
              step="0.1"
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
              placeholder="0"
            />
          </label>
        ))}
      </div>
      <p className="muted" style={{ margin: "8px 0 0", fontSize: "13px" }}>
        {t("recipes.new.nutrition.hint")}
      </p>
    </div>
  );
}
