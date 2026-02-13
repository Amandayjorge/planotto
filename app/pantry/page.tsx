"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";

interface PantryItem {
  name: string;
  amount: number;
  unit: string;
}

const PANTRY_STORAGE_KEY = "pantry";
const VALID_UNITS = ["г", "кг", "мл", "л", "шт", "ч.л.", "ст.л.", "по вкусу"];

export default function PantryPage() {
  const [pantry, setPantry] = useState<PantryItem[]>(() => {
    if (typeof window === "undefined") return [];
    const storedPantry = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (!storedPantry) return [];
    try {
      const parsed = JSON.parse(storedPantry);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftItem, setDraftItem] = useState<PantryItem | null>(null);
  const [activeSuggestionField, setActiveSuggestionField] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [productSuggestions, setProductSuggestions] = useState<string[]>(() => loadProductSuggestions());

  useEffect(() => {
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(pantry));
  }, [pantry]);

  const validateItem = (item: PantryItem, index?: string): boolean => {
    const newErrors = { ...errors };
    const key = index || "new";
    delete newErrors[key];

    if (!item.name.trim()) {
      newErrors[key] = "Название не может быть пустым";
    } else if (item.amount < 0) {
      newErrors[key] = "Количество не может быть отрицательным";
    }

    setErrors(newErrors);
    return !newErrors[key];
  };

  const startEdit = (index: number) => {
    setEditingId(`edit-${index}`);
    setDraftItem({ ...pantry[index] });
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

    upsertSuggestions(draftItem.name);

    if (editingId === "new") {
      setPantry((prev) => [...prev, draftItem]);
    } else {
      const index = Number(editingId.replace("edit-", ""));
      setPantry((prev) => prev.map((item, i) => (i === index ? draftItem : item)));
    }

    setEditingId(null);
    setDraftItem(null);
  };

  const updateDraftItem = (field: "name" | "amount" | "unit", value: string | number) => {
    if (!draftItem) return;
    const updated = { ...draftItem };

    if (field === "name") updated.name = String(value);
    if (field === "amount") updated.amount = parseFloat(String(value)) || 0;
    if (field === "unit") updated.unit = String(value);

    setDraftItem(updated);
    validateItem(updated, editingId || undefined);
  };

  const removePantryItem = (index: number) => {
    setPantry((prev) => prev.filter((_, i) => i !== index));
  };

  const addPantryItem = () => {
    setEditingId("new");
    setDraftItem({ name: "", amount: 0, unit: VALID_UNITS[0] });
    setActiveSuggestionField("new");
  };

  const addStarterPantryItems = () => {
    if (editingId !== null) return;
    const starterItems: PantryItem[] = [
      { name: "Молоко", amount: 1, unit: "л" },
      { name: "Яйца", amount: 10, unit: "шт" },
      { name: "Хлеб", amount: 1, unit: "шт" },
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
  const visibleItems = pantry
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !normalizedSearch || item.name.toLowerCase().includes(normalizedSearch));

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
      </div>

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
            <div className="pantry-table__cell">Действия</div>
          </div>

          {editingId === "new" && draftItem && (
            <div className="pantry-table__row" style={{ backgroundColor: "var(--background-secondary)" }}>
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
                  value={draftItem.amount}
                  onChange={(e) => updateDraftItem("amount", e.target.value)}
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
              <div className="pantry-table__cell actions">
                <div className="pantry-actions">
                  <button
                    onClick={saveEdit}
                    className="btn btn-primary"
                    style={{ padding: "4px 12px", fontSize: "12px" }}
                    disabled={!draftItem.name.trim()}
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
              <div key={index} className="pantry-table__row">
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
                      value={currentItem.amount}
                      onChange={(e) => updateDraftItem("amount", e.target.value)}
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
                <div className="pantry-table__cell actions">
                  {isEditing ? (
                    <div className="pantry-actions">
                      <button
                        onClick={saveEdit}
                        className="btn btn-primary"
                        style={{ padding: "4px 12px", fontSize: "12px" }}
                        disabled={!currentItem.name.trim()}
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
