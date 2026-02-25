"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";

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

export default function PantryPage() {
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
  const [categoryFilter, setCategoryFilter] = useState("");
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
      newErrors[key] = "Название не может быть пустым";
    } else if (item.amount === "") {
      newErrors[key] = "Введите количество";
    } else if (!Number.isFinite(item.amount) || item.amount <= 0) {
      newErrors[key] = "Количество должно быть больше 0";
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
      { name: "Молоко", amount: 1, unit: "л", category: "", updatedAt: nowIso() },
      { name: "Яйца", amount: 10, unit: "шт", category: "", updatedAt: nowIso() },
      { name: "Хлеб", amount: 1, unit: "шт", category: "", updatedAt: nowIso() },
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
  const categoryOptions = Array.from(
    new Set(pantry.map((item) => normalizeCategory(item.category)).filter((category) => category.length > 0))
  ).sort((a, b) => a.localeCompare(b, "ru-RU", { sensitivity: "base" }));

  const visibleItems = pantry
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (normalizedSearch && !item.name.toLowerCase().includes(normalizedSearch)) return false;
      if (categoryFilter && item.category !== categoryFilter) return false;
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

  return (
    <section className="card">
      <div style={{ marginBottom: "20px" }}>
        <Link href="/menu" className="btn" style={{ marginRight: "20px" }}>
          ← Назад к меню
        </Link>
      </div>

      <h1 className="h1" style={{ marginBottom: "20px", color: "var(--text-primary)" }}>
        Кладовка
      </h1>

      <p style={{ marginBottom: "16px", color: "var(--text-secondary)" }}>
        Используется при планировании меню и формировании списка покупок.
      </p>

      <div style={{ marginBottom: "20px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <button onClick={addPantryItem} className="btn btn-add" disabled={editingId !== null}>
            + Добавить продукт
          </button>
          <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-tertiary)" }}>
            Продукты, остатки, заготовки, заморозка
          </div>
        </div>
        {pantry.length > 0 && (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по продуктам"
            className="input"
            style={{ maxWidth: "320px" }}
          />
        )}
        {categoryOptions.length > 0 && (
          <select
            className="input"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            style={{ maxWidth: "240px" }}
          >
            <option value="">Все категории</option>
            {categoryOptions.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        )}
        <select
          className="input"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          style={{ maxWidth: "260px" }}
        >
          <option value="updatedAt">Сортировка: по дате обновления</option>
          <option value="name">Сортировка: по названию</option>
          <option value="amount">Сортировка: по количеству</option>
        </select>
      </div>

      {categoryOptions.length > 0 ? (
        <datalist id={CATEGORY_DATALIST_ID}>
          {categoryOptions.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      ) : null}

      {pantry.length === 0 && editingId !== "new" ? (
        <div className="empty-state">
          <div className="empty-state__title">Кладовка пока пуста</div>
          <div className="empty-state__description">Добавляйте продукты, которые есть дома.</div>
          <div className="empty-state__description">Они будут учитываться в меню и списке покупок.</div>
          <div style={{ marginTop: "16px", display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
            <button onClick={addStarterPantryItems} className="btn btn-primary" disabled={editingId !== null}>
              Добавить несколько продуктов
            </button>
            <Link href="/shopping-list" className="btn">
              Открыть покупки
            </Link>
          </div>
        </div>
      ) : visibleItems.length === 0 && editingId !== "new" ? (
        <div className="empty-state">
          <div className="empty-state__title">Ничего не найдено</div>
        </div>
      ) : (
        <div className="pantry-table">
          <div className="pantry-table__header">
            <div className="pantry-table__cell">Продукт</div>
            <div className="pantry-table__cell">Количество</div>
            <div className="pantry-table__cell">Единица</div>
            <div className="pantry-table__cell">Категория</div>
            <div className="pantry-table__cell">Действия</div>
          </div>

          {editingId === "new" && draftItem && (
            <div
              className={`pantry-table__row${activeSuggestionField === "new" ? " pantry-table__row--suggestions-open" : ""}`}
              style={{ backgroundColor: "var(--background-secondary)" }}
            >
              <div className="pantry-table__cell">
                <div className="pantry-name-input-wrap">
                  <input
                    type="text"
                    value={draftItem.name}
                    onChange={(e) => {
                      updateDraftItem("name", e.target.value);
                      setActiveSuggestionField("new");
                    }}
                    onFocus={() => setActiveSuggestionField("new")}
                    onBlur={() => {
                      setTimeout(() => {
                        setActiveSuggestionField((prev) => (prev === "new" ? null : prev));
                      }, 120);
                    }}
                    placeholder="Название"
                    className="input"
                    style={{ borderColor: errors.new ? "var(--state-warning)" : undefined }}
                    autoFocus
                    autoComplete="off"
                  />
                  {activeSuggestionField === "new" && (
                    <div className="pantry-suggestions">
                      {getSuggestions(draftItem.name).map((name) => (
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
                {errors.new && (
                  <div style={{ color: "var(--state-warning)", fontSize: "12px", marginTop: "4px" }}>{errors.new}</div>
                )}
              </div>
              <div className="pantry-table__cell">
                <input
                  type="number"
                  value={draftItem.amount === "" ? "" : draftItem.amount}
                  onChange={(e) => updateDraftItem("amount", e.target.value)}
                  onFocus={() => {
                    if (draftItem.amount === 0) updateDraftItem("amount", "");
                  }}
                  placeholder="0"
                  step="0.1"
                  min="0"
                  className="input"
                  style={{ textAlign: "center" }}
                />
              </div>
              <div className="pantry-table__cell">
                <select
                  value={draftItem.unit}
                  onChange={(e) => updateDraftItem("unit", e.target.value)}
                  className="input"
                  style={{ textAlign: "center" }}
                >
                  {VALID_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </div>
              <div className="pantry-table__cell">
                <input
                  type="text"
                  value={draftItem.category}
                  onChange={(e) => updateDraftItem("category", e.target.value)}
                  placeholder="Например: Овощи"
                  list={CATEGORY_DATALIST_ID}
                  className="input"
                />
              </div>
              <div className="pantry-table__cell actions">
                <div className="pantry-actions">
                  <button
                    onClick={saveEdit}
                    className="btn btn-primary"
                    style={{ padding: "4px 12px", fontSize: "12px" }}
                    disabled={!draftItem.name.trim() || draftItem.amount === "" || draftItem.amount <= 0}
                  >
                    Сохранить
                  </button>
                  <button onClick={cancelEdit} className="btn" style={{ padding: "4px 12px", fontSize: "12px" }}>
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          )}

          {visibleItems.map(({ item, index }) => {
            const isEditing = editingId === `edit-${index}`;
            const currentItem = isEditing && draftItem ? draftItem : item;

            return (
              <div
                key={index}
                className={`pantry-table__row${activeSuggestionField === `edit-${index}` ? " pantry-table__row--suggestions-open" : ""}`}
              >
                <div className="pantry-table__cell">
                  {isEditing ? (
                    <>
                      <div className="pantry-name-input-wrap">
                        <input
                          type="text"
                          value={currentItem.name}
                          onChange={(e) => {
                            updateDraftItem("name", e.target.value);
                            setActiveSuggestionField(`edit-${index}`);
                          }}
                          onFocus={() => setActiveSuggestionField(`edit-${index}`)}
                          onBlur={() => {
                            setTimeout(() => {
                              setActiveSuggestionField((prev) => (prev === `edit-${index}` ? null : prev));
                            }, 120);
                          }}
                          placeholder="Название"
                          className="input"
                          style={{ borderColor: errors[`edit-${index}`] ? "var(--state-warning)" : undefined }}
                          autoFocus
                          autoComplete="off"
                        />
                        {activeSuggestionField === `edit-${index}` && (
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
                      {errors[`edit-${index}`] && (
                        <div style={{ color: "var(--state-warning)", fontSize: "12px", marginTop: "4px" }}>
                          {errors[`edit-${index}`]}
                        </div>
                      )}
                    </>
                  ) : (
                    <span>{item.name}</span>
                  )}
                </div>
                <div className="pantry-table__cell">
                  {isEditing ? (
                    <input
                      type="number"
                      value={currentItem.amount === "" ? "" : currentItem.amount}
                      onChange={(e) => updateDraftItem("amount", e.target.value)}
                      onFocus={() => {
                        if (currentItem.amount === 0) updateDraftItem("amount", "");
                      }}
                      placeholder="0"
                      step="0.1"
                      min="0"
                      className="input"
                      style={{ textAlign: "center" }}
                    />
                  ) : (
                    <span>{item.amount}</span>
                  )}
                </div>
                <div className="pantry-table__cell">
                  {isEditing ? (
                    <select
                      value={currentItem.unit}
                      onChange={(e) => updateDraftItem("unit", e.target.value)}
                      className="input"
                      style={{ textAlign: "center" }}
                    >
                      {VALID_UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{item.unit}</span>
                  )}
                </div>
                <div className="pantry-table__cell">
                  {isEditing ? (
                    <input
                      type="text"
                      value={currentItem.category}
                      onChange={(e) => updateDraftItem("category", e.target.value)}
                      placeholder="Например: Овощи"
                      list={CATEGORY_DATALIST_ID}
                      className="input"
                    />
                  ) : (
                    <span>{item.category || "—"}</span>
                  )}
                </div>
                <div className="pantry-table__cell actions">
                  {isEditing ? (
                    <div className="pantry-actions">
                      <button
                        onClick={saveEdit}
                        className="btn btn-primary"
                        style={{ padding: "4px 12px", fontSize: "12px" }}
                        disabled={!currentItem.name.trim() || currentItem.amount === "" || currentItem.amount <= 0}
                      >
                        Сохранить
                      </button>
                      <button onClick={cancelEdit} className="btn" style={{ padding: "4px 12px", fontSize: "12px" }}>
                        Отмена
                      </button>
                    </div>
                  ) : (
                    <div className="pantry-actions">
                      <button onClick={() => startEdit(index)} className="btn" style={{ padding: "4px 12px", fontSize: "12px" }}>
                        Редактировать
                      </button>
                      <button
                        onClick={() => removePantryItem(index)}
                        className="btn btn-danger"
                        style={{ padding: "4px 12px", fontSize: "12px" }}
                      >
                        Удалить
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}


      <div style={{ marginTop: "30px", fontSize: "14px", color: "var(--text-secondary)" }}>
        <p>Сохранено продуктов: {pantry.length}</p>
      </div>
    </section>
  );
}
