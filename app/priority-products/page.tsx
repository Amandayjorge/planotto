"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProductAutocompleteInput from "../components/ProductAutocompleteInput";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";
import {
  addPriorityProduct,
  getActivePriorityProducts,
  loadPriorityProducts,
  removePriorityProduct,
  resolveUntilDate,
  type PriorityPeriodMode,
} from "../lib/priorityProducts";

const periodTitle = (mode: PriorityPeriodMode): string => {
  if (mode === "today") return "Сегодня";
  if (mode === "week") return "Эта неделя";
  if (mode === "days") return "На N дней";
  return "До даты";
};

export default function PriorityProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState(() => loadPriorityProducts());
  const [name, setName] = useState("");
  const [periodMode, setPeriodMode] = useState<PriorityPeriodMode>("week");
  const [daysCount, setDaysCount] = useState(7);
  const [untilDate, setUntilDate] = useState(() => resolveUntilDate("week", 7));
  const [preferOften, setPreferOften] = useState(true);
  const [message, setMessage] = useState("");
  const [productSuggestions] = useState<string[]>(() => loadProductSuggestions());

  const activeProducts = useMemo(() => getActivePriorityProducts(), [products]);
  const archivedProducts = useMemo(
    () => products.filter((item) => !activeProducts.some((active) => active.id === item.id)),
    [products, activeProducts]
  );

  const refreshProducts = () => setProducts(loadPriorityProducts());

  useEffect(() => {
    refreshProducts();
  }, []);

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
      preferOften,
    });

    if (!created) {
      setMessage("Не удалось добавить продукт.");
      return;
    }

    appendProductSuggestions([created.name]);
    setName("");
    setMessage("Продукт периода сохранен.");
    refreshProducts();
  };

  const handleRemove = (id: string) => {
    removePriorityProduct(id);
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
        Продукты периода
      </h1>

      <p className="muted" style={{ marginBottom: "16px" }}>
        Рецепты с этими продуктами поднимаются выше в выдаче и рекомендациях.
      </p>

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
            Период
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

          {periodMode === "days" && (
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
          )}

          {periodMode === "date" && (
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
          )}

          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <input
              type="checkbox"
              checked={preferOften}
              onChange={(e) => setPreferOften(e.target.checked)}
            />
            Хочу чаще использовать в первую очередь
          </label>

          <div>
            <button className="btn btn-primary" onClick={handleAdd}>
              Добавить продукт периода
            </button>
          </div>
        </div>
      </div>

      {message && (
        <p className="muted" style={{ marginBottom: "16px" }}>
          {message}
        </p>
      )}

      <div className="card" style={{ marginBottom: "16px" }}>
        <h3 style={{ marginTop: 0, marginBottom: "10px" }}>Активные ({activeProducts.length})</h3>
        {activeProducts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Пока нет активных продуктов периода.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {activeProducts.map((item) => (
              <div
                key={item.id}
                style={{
                  border: "1px solid var(--border-default)",
                  borderRadius: "10px",
                  padding: "10px",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "10px",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{item.name}</div>
                  <div className="muted" style={{ fontSize: "13px" }}>
                    {periodTitle(item.periodMode)} · до {item.untilDate}
                    {item.preferOften ? " · чаще использовать" : ""}
                  </div>
                </div>
                <button className="btn btn-danger" onClick={() => handleRemove(item.id)}>
                  Удалить
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {archivedProducts.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0, marginBottom: "10px" }}>Истекшие ({archivedProducts.length})</h3>
          <div style={{ display: "grid", gap: "8px" }}>
            {archivedProducts.map((item) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                <div className="muted">
                  {item.name} · до {item.untilDate}
                </div>
                <button className="btn" onClick={() => handleRemove(item.id)}>
                  Убрать
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

