"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProductAutocompleteInput from "../components/ProductAutocompleteInput";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";
import {
  addPriorityProduct,
  isPriorityProductActive,
  loadPriorityProducts,
  removePriorityProduct,
  resolveUntilDate,
  updatePriorityProduct,
  type PriorityPeriodMode,
  type PriorityProduct,
} from "../lib/priorityProducts";

const formatDateLabel = (iso: string): string => {
  const [y, m, d] = iso.split("-").map((part) => Number(part));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
};

const periodSummary = (item: PriorityProduct): string => {
  if (item.periodMode === "today") return "Сегодня";
  if (item.periodMode === "week") return "Эта неделя";
  return `До ${formatDateLabel(item.untilDate)}`;
};

const getDaysForEditor = (item: PriorityProduct): number => {
  if (item.periodMode !== "days") return 7;
  const created = new Date(item.createdAt);
  if (Number.isNaN(created.getTime())) return 7;

  const [y, m, d] = item.untilDate.split("-").map((part) => Number(part));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 7;

  const untilDate = new Date(y, m - 1, d);
  const createdDate = new Date(created.getFullYear(), created.getMonth(), created.getDate());
  const diffDays = Math.round((untilDate.getTime() - createdDate.getTime()) / 86400000) + 1;
  if (!Number.isFinite(diffDays)) return 7;
  return Math.min(31, Math.max(1, diffDays));
};

export default function PriorityProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState(() => loadPriorityProducts());
  const [name, setName] = useState("");
  const [periodMode, setPeriodMode] = useState<PriorityPeriodMode>("week");
  const [daysCount, setDaysCount] = useState(7);
  const [untilDate, setUntilDate] = useState(() => resolveUntilDate("week", 7));
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [productSuggestions] = useState<string[]>(() => loadProductSuggestions());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPeriodMode, setEditPeriodMode] = useState<PriorityPeriodMode>("week");
  const [editDaysCount, setEditDaysCount] = useState(7);
  const [editUntilDate, setEditUntilDate] = useState(() => resolveUntilDate("week", 7));
  const [editNote, setEditNote] = useState("");

  const activeProducts = useMemo(() => products.filter((item) => isPriorityProductActive(item)), [products]);
  const archivedProducts = useMemo(
    () => products.filter((item) => !activeProducts.some((active) => active.id === item.id)),
    [products, activeProducts]
  );

  const refreshProducts = () => setProducts(loadPriorityProducts());

  const handleAdd = () => {
    if (!name.trim()) {
      setMessage("Введите продукт.");
      return;
    }

    const created = addPriorityProduct({
      name,
      periodMode,
      days: daysCount,
      untilDate,
      note,
    });

    if (!created) {
      setMessage("Не удалось добавить продукт.");
      return;
    }

    appendProductSuggestions([created.name]);
    setName("");
    setNote("");
    setMessage("Продукт сохранен.");
    refreshProducts();
  };

  const handleRemove = (id: string) => {
    removePriorityProduct(id);
    if (editingId === id) {
      setEditingId(null);
    }
    refreshProducts();
  };

  const openEditor = (item: PriorityProduct) => {
    setEditingId(item.id);
    setEditName(item.name);
    setEditPeriodMode(item.periodMode);
    setEditDaysCount(getDaysForEditor(item));
    setEditUntilDate(item.untilDate || resolveUntilDate("date", 7));
    setEditNote(item.note || "");
  };

  const handleSaveEdit = () => {
    if (!editingId) return;

    const updated = updatePriorityProduct(editingId, {
      name: editName,
      periodMode: editPeriodMode,
      days: editDaysCount,
      untilDate: editUntilDate,
      note: editNote,
    });

    if (!updated) {
      setMessage("Не удалось сохранить изменения.");
      return;
    }

    appendProductSuggestions([updated.name]);
    setEditingId(null);
    setMessage("Изменения сохранены.");
    refreshProducts();
  };

  return (
    <div style={{ padding: "20px", maxWidth: "920px", margin: "0 auto" }}>
      <div style={{ marginBottom: "16px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button className="btn" onClick={() => router.push("/recipes")}>
          ← К рецептам
        </button>
        <button className="btn" onClick={() => router.push("/menu")}>
          К меню
        </button>
      </div>

      <h1 className="h1" style={{ marginBottom: "10px" }}>
        Активные продукты
      </h1>

      <div className="card" style={{ marginBottom: "16px" }}>
        <div style={{ display: "grid", gap: "12px" }}>
          <label style={{ display: "block", fontWeight: 600 }}>
            Продукт
            <div style={{ marginTop: "8px" }}>
              <ProductAutocompleteInput
                value={name}
                onChange={setName}
                suggestions={productSuggestions}
                placeholder="Например: лосось"
              />
            </div>
          </label>

          <label style={{ display: "block", fontWeight: 600 }}>
            Действует
            <select
              className="input"
              value={periodMode}
              onChange={(e) => setPeriodMode(e.target.value as PriorityPeriodMode)}
              style={{ marginTop: "8px", maxWidth: "220px" }}
            >
              <option value="today">Сегодня</option>
              <option value="week">Эта неделя</option>
              <option value="days">На N дней</option>
              <option value="date">До даты</option>
            </select>
          </label>

          {periodMode === "days" ? (
            <label style={{ display: "block", fontWeight: 600 }}>
              Количество дней
              <input
                className="input"
                type="number"
                min={1}
                max={31}
                value={daysCount}
                onChange={(e) => setDaysCount(Math.max(1, Number(e.target.value || 1)))}
                style={{ marginTop: "8px", maxWidth: "140px" }}
              />
            </label>
          ) : null}

          {periodMode === "date" ? (
            <label style={{ display: "block", fontWeight: 600 }}>
              До даты
              <input
                className="input"
                type="date"
                value={untilDate}
                onChange={(e) => setUntilDate(e.target.value)}
                style={{ marginTop: "8px", maxWidth: "220px" }}
              />
            </label>
          ) : null}

          <label style={{ display: "block", fontWeight: 600 }}>
            Заметка
            <input
              className="input"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={120}
              placeholder="Например: по акции / использовать остаток"
              style={{ marginTop: "8px", maxWidth: "420px" }}
            />
          </label>

          <div>
            <button className="btn btn-primary" onClick={handleAdd}>
              Добавить продукт
            </button>
          </div>
        </div>
      </div>

      {message ? (
        <p className="muted" style={{ marginBottom: "16px" }}>
          {message}
        </p>
      ) : null}

      <div className="card" style={{ marginBottom: "16px" }}>
        <h3 style={{ marginTop: 0, marginBottom: "10px" }}>Активные ({activeProducts.length})</h3>
        {activeProducts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Пока нет активных продуктов.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {activeProducts.map((item) => {
              const isEditing = editingId === item.id;
              return (
                <div
                  key={item.id}
                  style={{
                    border: "1px solid var(--border-default)",
                    borderRadius: "10px",
                    padding: "10px",
                    display: "grid",
                    gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{item.name}</div>
                      <div className="muted" style={{ fontSize: "13px" }}>
                        {periodSummary(item)}
                      </div>
                      {item.note ? (
                        <div className="muted" style={{ fontSize: "12px", marginTop: "2px" }}>
                          {item.note}
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button className="btn" onClick={() => openEditor(item)}>
                        Редактировать
                      </button>
                      <button className="btn btn-danger" onClick={() => handleRemove(item.id)}>
                        Удалить
                      </button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div
                      style={{
                        borderTop: "1px solid var(--border-default)",
                        paddingTop: "8px",
                        display: "grid",
                        gap: "8px",
                      }}
                    >
                      <label style={{ display: "block", fontWeight: 600 }}>
                        Продукт
                        <input
                          className="input"
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          style={{ marginTop: "6px" }}
                        />
                      </label>

                      <label style={{ display: "block", fontWeight: 600 }}>
                        Действует
                        <select
                          className="input"
                          value={editPeriodMode}
                          onChange={(e) => setEditPeriodMode(e.target.value as PriorityPeriodMode)}
                          style={{ marginTop: "6px", maxWidth: "220px" }}
                        >
                          <option value="today">Сегодня</option>
                          <option value="week">Эта неделя</option>
                          <option value="days">На N дней</option>
                          <option value="date">До даты</option>
                        </select>
                      </label>

                      {editPeriodMode === "days" ? (
                        <label style={{ display: "block", fontWeight: 600 }}>
                          Количество дней
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={31}
                            value={editDaysCount}
                            onChange={(e) => setEditDaysCount(Math.max(1, Number(e.target.value || 1)))}
                            style={{ marginTop: "6px", maxWidth: "140px" }}
                          />
                        </label>
                      ) : null}

                      {editPeriodMode === "date" ? (
                        <label style={{ display: "block", fontWeight: 600 }}>
                          До даты
                          <input
                            className="input"
                            type="date"
                            value={editUntilDate}
                            onChange={(e) => setEditUntilDate(e.target.value)}
                            style={{ marginTop: "6px", maxWidth: "220px" }}
                          />
                        </label>
                      ) : null}

                      <label style={{ display: "block", fontWeight: 600 }}>
                        Заметка
                        <input
                          className="input"
                          type="text"
                          value={editNote}
                          onChange={(e) => setEditNote(e.target.value)}
                          maxLength={120}
                          placeholder="Например: по акции / использовать остаток"
                          style={{ marginTop: "6px", maxWidth: "420px" }}
                        />
                      </label>

                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button className="btn btn-primary" onClick={handleSaveEdit}>
                          Сохранить
                        </button>
                        <button className="btn" onClick={() => setEditingId(null)}>
                          Отмена
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {archivedProducts.length > 0 ? (
        <div className="card">
          <h3 style={{ marginTop: 0, marginBottom: "10px" }}>Истекшие ({archivedProducts.length})</h3>
          <div style={{ display: "grid", gap: "8px" }}>
            {archivedProducts.map((item) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                <div className="muted">
                  {item.name} · {periodSummary(item)}
                </div>
                <button className="btn" onClick={() => handleRemove(item.id)}>
                  Убрать
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
