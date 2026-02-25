"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";
import { useI18n } from "../components/I18nProvider";

interface PantryItem {
  name: string;
  amount: number;
  unit: string;
  category: string;
  updatedAt: string;
}

interface PantryDraftItem {
  name: string;
  amount: number | "";
  unit: string;
  category: string;
}

type SortMode = "name" | "amount" | "updatedAt";

const PANTRY_STORAGE_KEY = "pantry";
const VALID_UNITS = ["г", "кг", "мл", "л", "шт", "ч.л.", "ст.л.", "по вкусу"];
const CATEGORY_DATALIST_ID = "pantry-category-options";
const CATEGORY_FILTER_ALL = "__all__";
const CATEGORY_FILTER_NONE = "__none__";
const BASE_CATEGORIES = [
  { name: "Овощи и фрукты", emoji: "🥦", labelKey: "pantry.categories.vegetablesFruits" },
  { name: "Мясо и рыба", emoji: "🥩", labelKey: "pantry.categories.meatFish" },
  { name: "Молочные продукты", emoji: "🧀", labelKey: "pantry.categories.dairy" },
  { name: "Выпечка и хлеб", emoji: "🥖", labelKey: "pantry.categories.breadBakery" },
  { name: "Бакалея", emoji: "🥫", labelKey: "pantry.categories.grocery" },
  { name: "Заморозка", emoji: "🧊", labelKey: "pantry.categories.frozen" },
  { name: "Напитки", emoji: "🧃", labelKey: "pantry.categories.drinks" },
  { name: "Снеки и сладости", emoji: "🍫", labelKey: "pantry.categories.snacksSweets" },
  { name: "Специи и соусы", emoji: "🧂", labelKey: "pantry.categories.spicesSauces" },
] as const;

const normalizeCategory = (value: string): string => value.trim().replace(/\s+/g, " ");
const nowIso = (): string => new Date().toISOString();

const normalizePantryItem = (raw: unknown): PantryItem | null => {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<PantryItem>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const amount = Number(row.amount);
  const unit = typeof row.unit === "string" ? row.unit : "";
  if (!name || !Number.isFinite(amount) || amount <= 0 || !unit) return null;
  return {
    name,
    amount,
    unit,
    category: normalizeCategory(typeof row.category === "string" ? row.category : ""),
    updatedAt: typeof row.updatedAt === "string" && row.updatedAt.trim() ? row.updatedAt : nowIso(),
  };
};

const getCategoryEmoji = (category: string): string => {
  const normalized = normalizeCategory(category);
  const found = BASE_CATEGORIES.find((item) => item.name.toLocaleLowerCase("ru-RU") === normalized.toLocaleLowerCase("ru-RU"));
  return found?.emoji || "📦";
};

const getProductEmoji = (name: string, category: string): string => {
  const value = name.trim().toLocaleLowerCase("ru-RU");
  if (!value) return getCategoryEmoji(category);
  if (value.includes("молок") || value.startsWith("мол")) return "🥛";
  if (value.includes("кофе")) return "☕";
  if (value.includes("чай")) return "🍵";
  if (value.includes("хлеб") || value.includes("булк")) return "🍞";
  if (value.includes("сыр")) return "🧀";
  if (value.includes("йогурт") || value.includes("кефир")) return "🥛";
  if (value.includes("яйц")) return "🥚";
  if (value.includes("куриц") || value.includes("мяс")) return "🍗";
  if (value.includes("рыб") || value.includes("лосос")) return "🐟";
  if (value.includes("яблок") || value.includes("банан") || value.includes("фрукт")) return "🍎";
  if (value.includes("помидор") || value.includes("огур") || value.includes("овощ")) return "🥬";
  if (value.includes("вода") || value.includes("сок") || value.includes("напит")) return "🧃";
  return getCategoryEmoji(category);
};

const formatUpdatedLabel = (
  iso: string,
  locale: string,
  t: (key: string, params?: Record<string, string | number>) => string
): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t("pantry.updated.unknown");
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayStart.getTime() - targetStart.getTime()) / 86400000);
  if (diffDays === 0) return t("pantry.updated.today");
  if (diffDays === 1) return t("pantry.updated.yesterday");
  const localeMap: Record<string, string> = {
    ru: "ru-RU",
    en: "en-US",
    es: "es-ES",
  };
  return targetStart.toLocaleDateString(localeMap[locale] || "en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const isUpdatedToday = (iso: string): boolean => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
};

const getProductWord = (
  count: number,
  t: (key: string, params?: Record<string, string | number>) => string
): string => {
  const abs = Math.abs(count) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return t("pantry.words.productsPlural");
  if (tail === 1) return t("pantry.words.productOne");
  if (tail >= 2 && tail <= 4) return t("pantry.words.productFew");
  return t("pantry.words.productsPlural");
};

export default function PantryPage() {
  const { locale, t } = useI18n();
  const [pantry, setPantry] = useState<PantryItem[]>(() => {
    if (typeof window === "undefined") return [];
    const storedPantry = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (!storedPantry) return [];
    try {
      const parsed = JSON.parse(storedPantry);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => normalizePantryItem(item))
        .filter((item): item is PantryItem => Boolean(item));
    } catch {
      return [];
    }
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftItem, setDraftItem] = useState<PantryDraftItem | null>(null);
  const [activeSuggestionField, setActiveSuggestionField] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(CATEGORY_FILTER_ALL);
  const [sortMode, setSortMode] = useState<SortMode>("updatedAt");
  const [productSuggestions, setProductSuggestions] = useState<string[]>(() => loadProductSuggestions());

  useEffect(() => {
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(pantry));
  }, [pantry]);

  const validateItem = (item: PantryDraftItem, index?: string): boolean => {
    const newErrors = { ...errors };
    const key = index || "new";
    delete newErrors[key];

    if (!item.name.trim()) {
      newErrors[key] = t("pantry.validation.nameRequired");
    } else if (item.amount === "") {
      newErrors[key] = t("pantry.validation.amountRequired");
    } else if (!Number.isFinite(item.amount) || item.amount <= 0) {
      newErrors[key] = t("pantry.validation.amountPositive");
    }

    setErrors(newErrors);
    return !newErrors[key];
  };

  const startEdit = (index: number) => {
    setEditingId(`edit-${index}`);
    setDraftItem({
      name: pantry[index].name,
      amount: pantry[index].amount > 0 ? pantry[index].amount : "",
      unit: pantry[index].unit,
      category: pantry[index].category || "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftItem(null);
    setActiveSuggestionField(null);
    setErrors({});
  };

  const upsertSuggestions = (name: string) => {
    const normalized = name.trim();
    if (!normalized) return;
    appendProductSuggestions([normalized]);
    setProductSuggestions(loadProductSuggestions());
  };

  const saveEdit = () => {
    if (!draftItem || !editingId) return;
    if (!validateItem(draftItem, editingId)) return;

    const payload: PantryItem = {
      name: draftItem.name.trim(),
      amount: Number(draftItem.amount),
      unit: draftItem.unit,
      category: normalizeCategory(draftItem.category),
      updatedAt: nowIso(),
    };

    upsertSuggestions(payload.name);

    if (editingId === "new") {
      setPantry((prev) => [...prev, payload]);
    } else {
      const index = Number(editingId.replace("edit-", ""));
      setPantry((prev) => prev.map((item, i) => (i === index ? payload : item)));
    }

    setEditingId(null);
    setDraftItem(null);
  };

  const updateDraftItem = (field: "name" | "amount" | "unit" | "category", value: string | number) => {
    if (!draftItem) return;
    const updated = { ...draftItem };

    if (field === "name") updated.name = String(value);
    if (field === "amount") {
      const raw = String(value).trim();
      if (!raw) {
        updated.amount = "";
      } else {
        const parsed = Number(raw);
        updated.amount = Number.isFinite(parsed) ? parsed : "";
      }
    }
    if (field === "unit") updated.unit = String(value);
    if (field === "category") updated.category = String(value);

    setDraftItem(updated);
    validateItem(updated, editingId || undefined);
  };

  const removePantryItem = (index: number) => {
    setPantry((prev) => prev.filter((_, i) => i !== index));
  };

  const addPantryItem = () => {
    setEditingId("new");
    setDraftItem({ name: "", amount: "", unit: VALID_UNITS[0], category: "" });
    setActiveSuggestionField("new");
  };

  const addStarterPantryItems = () => {
    if (editingId !== null) return;
    const starterItems: PantryItem[] = [
      { name: t("pantry.starter.milk"), amount: 1, unit: "л", category: "", updatedAt: nowIso() },
      { name: t("pantry.starter.eggs"), amount: 10, unit: "шт", category: "", updatedAt: nowIso() },
      { name: t("pantry.starter.bread"), amount: 1, unit: "шт", category: "", updatedAt: nowIso() },
    ];
    setPantry((prev) => [...prev, ...starterItems]);
    appendProductSuggestions(starterItems.map((item) => item.name));
    setProductSuggestions(loadProductSuggestions());
  };

  const getSuggestions = (value: string): string[] => {
    const query = value.trim().toLowerCase();
    if (query.length < 2) return [];
    return productSuggestions
      .filter((name) => name.toLowerCase().includes(query))
      .slice(0, 6);
  };

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const existingCategories = Array.from(
    new Set(pantry.map((item) => normalizeCategory(item.category)).filter((category) => category.length > 0))
  ).sort((a, b) => a.localeCompare(b, "ru-RU", { sensitivity: "base" }));
  const categoryOptions = Array.from(
    new Set([
      ...BASE_CATEGORIES.map((item) => item.name),
      ...existingCategories,
    ])
  );
  const baseCategorySet = new Set(BASE_CATEGORIES.map((item) => item.name.toLocaleLowerCase("ru-RU")));
  const customCategoryChips = existingCategories.filter(
    (category) => !baseCategorySet.has(category.toLocaleLowerCase("ru-RU"))
  );
  const categoryChips: Array<{ value: string; label: string; emoji?: string }> = [
    { value: CATEGORY_FILTER_ALL, label: t("pantry.filters.all") },
    ...BASE_CATEGORIES.map((category) => ({
      value: category.name,
      label: t(category.labelKey),
      emoji: category.emoji,
    })),
    { value: CATEGORY_FILTER_NONE, label: t("pantry.filters.uncategorized"), emoji: "🏷️" },
    ...customCategoryChips.map((category) => ({
      value: category,
      label: category,
      emoji: getCategoryEmoji(category),
    })),
  ];

  const visibleItems = pantry
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (normalizedSearch && !item.name.toLowerCase().includes(normalizedSearch)) return false;
      if (categoryFilter === CATEGORY_FILTER_NONE && normalizeCategory(item.category).length > 0) return false;
      if (
        categoryFilter !== CATEGORY_FILTER_ALL &&
        categoryFilter !== CATEGORY_FILTER_NONE &&
        item.category !== categoryFilter
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortMode === "name") {
        return a.item.name.localeCompare(b.item.name, "ru-RU", { sensitivity: "base" });
      }
      if (sortMode === "amount") {
        if (b.item.amount !== a.item.amount) return b.item.amount - a.item.amount;
        return a.item.name.localeCompare(b.item.name, "ru-RU", { sensitivity: "base" });
      }
      const aTime = Date.parse(a.item.updatedAt || "");
      const bTime = Date.parse(b.item.updatedAt || "");
      const safeATime = Number.isFinite(aTime) ? aTime : 0;
      const safeBTime = Number.isFinite(bTime) ? bTime : 0;
      if (safeBTime !== safeATime) return safeBTime - safeATime;
      return a.item.name.localeCompare(b.item.name, "ru-RU", { sensitivity: "base" });
    });

  const pantryCountLabel =
    pantry.length < 5
      ? t("pantry.count.inPantry", {
          count: pantry.length,
          word: getProductWord(pantry.length, t),
        })
      : t("pantry.count.available", {
          count: pantry.length,
          word: getProductWord(pantry.length, t),
        });

  const renderEditorFields = (currentItem: PantryDraftItem, suggestionKey: string, errorKey: string) => (
    <>
      <div className="pantry-name-input-wrap">
        <input
          type="text"
          value={currentItem.name}
          onChange={(e) => {
            updateDraftItem("name", e.target.value);
            setActiveSuggestionField(suggestionKey);
          }}
          onFocus={() => setActiveSuggestionField(suggestionKey)}
          onBlur={() => {
            setTimeout(() => {
              setActiveSuggestionField((prev) => (prev === suggestionKey ? null : prev));
            }, 120);
          }}
          placeholder={t("pantry.form.namePlaceholder")}
          className="input"
          style={{ borderColor: errors[errorKey] ? "var(--state-warning)" : undefined }}
          autoFocus={editingId === suggestionKey}
          autoComplete="off"
        />
        {activeSuggestionField === suggestionKey && (
          <div className="pantry-suggestions">
            {getSuggestions(currentItem.name).map((name) => (
              <button
                key={name}
                type="button"
                className="pantry-suggestion"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  updateDraftItem("name", name);
                  setActiveSuggestionField(null);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      {errors[errorKey] ? (
        <div style={{ color: "var(--state-warning)", fontSize: "12px", marginTop: "4px" }}>{errors[errorKey]}</div>
      ) : null}
      <div className="pantry-card__editor-grid">
        <input
          type="number"
          value={currentItem.amount === "" ? "" : currentItem.amount}
          onChange={(e) => updateDraftItem("amount", e.target.value)}
          placeholder="0"
          step="0.1"
          min="0"
          className="input"
        />
        <select
          value={currentItem.unit}
          onChange={(e) => updateDraftItem("unit", e.target.value)}
          className="input"
        >
          {VALID_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </div>
      <input
        type="text"
        value={currentItem.category}
        onChange={(e) => updateDraftItem("category", e.target.value)}
        placeholder={t("pantry.form.categoryPlaceholder")}
        list={CATEGORY_DATALIST_ID}
        className="input"
      />
    </>
  );

  return (
    <section className="card pantry-page">
      <div style={{ marginBottom: "20px" }}>
        <Link href="/menu" className="btn" style={{ marginRight: "20px" }}>
          {t("pantry.actions.backToMenu")}
        </Link>
      </div>

      <h1 className="h1" style={{ marginBottom: "20px", color: "var(--text-primary)" }}>
        {t("pantry.title")}
      </h1>

      <p className="pantry-count-label">
        <span aria-hidden="true">📦</span>
        <span>{pantryCountLabel}</span>
      </p>

      <div className="pantry-toolbar">
        <button onClick={addPantryItem} className="btn btn-add" disabled={editingId !== null}>
          {t("pantry.actions.addProduct")}
        </button>
        {pantry.length > 0 ? (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("pantry.form.searchPlaceholder")}
            className="input"
            style={{ maxWidth: "320px" }}
          />
        ) : null}
        <select
          className="input"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          style={{ maxWidth: "260px" }}
        >
          <option value="updatedAt">{t("pantry.sort.updatedAt")}</option>
          <option value="name">{t("pantry.sort.name")}</option>
          <option value="amount">{t("pantry.sort.amount")}</option>
        </select>
      </div>

      <div className="pantry-category-strip">
        <div className="pantry-category-chips">
          {categoryChips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={`pantry-chip${categoryFilter === chip.value ? " pantry-chip--active" : ""}`}
              onClick={() => setCategoryFilter(chip.value)}
            >
              {chip.emoji ? `${chip.emoji} ` : ""}
              {chip.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pantry-category-hint" aria-hidden="true">{t("pantry.filters.scrollHint")}</div>

      {categoryOptions.length > 0 ? (
        <datalist id={CATEGORY_DATALIST_ID}>
          {categoryOptions.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      ) : null}

      {pantry.length === 0 && editingId !== "new" ? (
        <div className="empty-state">
          <div className="empty-state__title">{t("pantry.empty.title")}</div>
          <div className="empty-state__description">{t("pantry.empty.description1")}</div>
          <div className="empty-state__description">{t("pantry.empty.description2")}</div>
          <div style={{ marginTop: "16px", display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
            <button onClick={addStarterPantryItems} className="btn btn-primary" disabled={editingId !== null}>
              {t("pantry.actions.addStarter")}
            </button>
            <Link href="/shopping-list" className="btn">
              {t("pantry.actions.openShopping")}
            </Link>
          </div>
        </div>
      ) : visibleItems.length === 0 && editingId !== "new" ? (
        <div className="empty-state">
          <div className="empty-state__title">{t("pantry.empty.notFound")}</div>
        </div>
      ) : (
        <div className="pantry-cards">
          {editingId === "new" && draftItem && (
            <article className="pantry-card pantry-card--new">
              <div className="pantry-card__title">
                <span className="pantry-card__emoji">➕</span>
                <span>{t("pantry.editor.addTitle")}</span>
              </div>
              {renderEditorFields(draftItem, "new", "new")}
              <div className="pantry-card__actions">
                <button
                  onClick={saveEdit}
                  className="btn btn-primary"
                  disabled={!draftItem.name.trim() || draftItem.amount === "" || draftItem.amount <= 0}
                >
                  {t("pantry.actions.save")}
                </button>
                <button onClick={cancelEdit} className="btn">
                  {t("pantry.actions.cancel")}
                </button>
              </div>
            </article>
          )}

          {visibleItems.map(({ item, index }) => {
            const isEditing = editingId === `edit-${index}`;
            const currentItem = isEditing && draftItem ? draftItem : item;
            const cardEmoji = getProductEmoji(item.name, item.category);

            return (
              <article key={index} className={`pantry-card${isEditing ? " pantry-card--editing" : ""}`}>
                {isEditing ? (
                  <>
                    <div className="pantry-card__title">
                      <span className="pantry-card__emoji">{cardEmoji}</span>
                      <span>{t("pantry.editor.editTitle")}</span>
                    </div>
                    {renderEditorFields(currentItem, `edit-${index}`, `edit-${index}`)}
                    <div className="pantry-card__actions">
                      <button
                        onClick={saveEdit}
                        className="btn btn-primary"
                        disabled={!currentItem.name.trim() || currentItem.amount === "" || currentItem.amount <= 0}
                      >
                        {t("pantry.actions.save")}
                      </button>
                      <button onClick={cancelEdit} className="btn">
                        {t("pantry.actions.cancel")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="pantry-card__title">
                      <span className="pantry-card__emoji">{cardEmoji}</span>
                      <span>{item.name}</span>
                    </div>
                    <div className="pantry-card__amount">
                      {item.amount} {item.unit}
                    </div>
                    <div className="pantry-card__meta-row">
                      <div className="pantry-card__updated">
                        <span
                          className={`pantry-card__updated-dot${isUpdatedToday(item.updatedAt) ? " pantry-card__updated-dot--today" : ""}`}
                          aria-hidden="true"
                        />
                        <span>
                          {t("pantry.updated.label")} {formatUpdatedLabel(item.updatedAt, locale, t)}
                        </span>
                      </div>
                      <div className="pantry-card__actions pantry-card__actions--compact">
                        <button
                          onClick={() => startEdit(index)}
                          className="btn pantry-card__icon-btn"
                          aria-label={t("pantry.actions.editItemAria", { name: item.name })}
                          title={t("pantry.actions.edit")}
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => removePantryItem(index)}
                          className="btn pantry-card__icon-btn pantry-card__icon-btn--danger"
                          aria-label={t("pantry.actions.deleteItemAria", { name: item.name })}
                          title={t("pantry.actions.delete")}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}


      <div style={{ marginTop: "30px", fontSize: "14px", color: "var(--text-secondary)" }}>
        <p>{t("pantry.savedCount", { count: pantry.length })}</p>
      </div>
    </section>
  );
}
