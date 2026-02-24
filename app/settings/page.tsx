"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const MENU_STORAGE_KEY = "weeklyMenu";
const RANGE_STATE_KEY = "selectedMenuRange";
const WEEK_START_KEY = "selectedWeekStart";
const MENU_SHOPPING_MERGE_KEY_PREFIX = "menuShoppingMerge";
const ACTIVE_PRODUCTS_KEY_PREFIX = "activeProducts";
const DAY_STRUCTURE_MODE_KEY = "menuDayStructureMode";
const MEAL_STRUCTURE_SETTINGS_KEY = "menuMealStructureSettings";
const MEAL_STRUCTURE_DEFAULT_SETTINGS_KEY = "menuMealStructureDefaults";
const MENU_STORAGE_VERSION = 2;
const DEFAULT_MENU_NAME = "Основное";
const DEFAULT_DAY_MEALS = ["Завтрак", "Обед", "Ужин"] as const;

type DayStructureMode = "list" | "meals";

interface MealSlotSetting {
  id: string;
  name: string;
  visible: boolean;
  order: number;
}

interface MenuProfileState {
  id: string;
  name: string;
  mealData: Record<string, unknown[]>;
  cellPeopleCount: Record<string, number>;
  cookedStatus: Record<string, boolean>;
}

interface MenuStorageBundleV2 {
  version: 2;
  activeMenuId: string;
  menus: MenuProfileState[];
}

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

const formatDisplayDate = (dateIso: string): string => {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return dateIso;
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
};

const normalizeMenuProfileName = (value: string): string => value.trim().replace(/\s+/g, " ");
const normalizeMealSlotName = (value: string): string => value.trim().replace(/\s+/g, " ");

const createDefaultMealSlots = (): MealSlotSetting[] =>
  DEFAULT_DAY_MEALS.map((name, index) => ({
    id: `default-${index}`,
    name,
    visible: true,
    order: index,
  }));

const parseMealSlots = (raw: string | null): MealSlotSetting[] | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rows = parsed
      .map((item) => item as Partial<MealSlotSetting>)
      .filter((item) => typeof item.name === "string" && normalizeMealSlotName(item.name).length > 0)
      .map((item, index) => ({
        id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
        name: normalizeMealSlotName(String(item.name || "")),
        visible: item.visible !== false,
        order: Number.isFinite(item.order) ? Number(item.order) : index,
      }));
    if (rows.length === 0) return null;
    return rows.sort((a, b) => a.order - b.order).map((item, index) => ({ ...item, order: index }));
  } catch {
    return null;
  }
};

const loadDayStructureMode = (): DayStructureMode => {
  if (typeof window === "undefined") return "list";
  const raw = localStorage.getItem(DAY_STRUCTURE_MODE_KEY);
  return raw === "meals" ? "meals" : "list";
};

const loadDefaultMealSlots = (): MealSlotSetting[] => {
  if (typeof window === "undefined") return createDefaultMealSlots();
  const defaults = parseMealSlots(window.localStorage.getItem(MEAL_STRUCTURE_DEFAULT_SETTINGS_KEY));
  if (defaults) return defaults;
  const legacy = parseMealSlots(window.localStorage.getItem(MEAL_STRUCTURE_SETTINGS_KEY));
  if (legacy) return legacy;
  return createDefaultMealSlots();
};

const loadMealSlotsForRange = (rangeKey: string): MealSlotSetting[] => {
  if (typeof window === "undefined") return createDefaultMealSlots();
  const byRange = parseMealSlots(window.localStorage.getItem(`${MEAL_STRUCTURE_SETTINGS_KEY}:${rangeKey}`));
  if (byRange) return byRange;
  return loadDefaultMealSlots();
};

const splitCellKey = (cellKey: string): { dayKey: string; mealLabel: string } | null => {
  const match = cellKey.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (!match) return null;
  return { dayKey: match[1], mealLabel: match[2] };
};

const normalizeMenuDataRecord = (value: unknown): Record<string, unknown[]> => {
  if (!value || typeof value !== "object") return {};
  const converted: Record<string, unknown[]> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, rawCell]) => {
    const rows = Array.isArray(rawCell) ? rawCell : [rawCell];
    converted[key] = rows.filter((row) => row && typeof row === "object");
  });
  return converted;
};

const normalizePeopleCountMap = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  const map: Record<string, number> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, raw]) => {
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) map[key] = num;
  });
  return map;
};

const normalizeCookedStatusMap = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== "object") return {};
  const map: Record<string, boolean> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, raw]) => {
    map[key] = raw === true;
  });
  return map;
};

const createMenuProfileState = (name: string, id?: string): MenuProfileState => ({
  id: id || crypto.randomUUID(),
  name: normalizeMenuProfileName(name) || DEFAULT_MENU_NAME,
  mealData: {},
  cellPeopleCount: {},
  cookedStatus: {},
});

const parseMenuBundleFromStorage = (
  raw: string | null,
  defaultMenuName: string
): { menus: MenuProfileState[]; activeMenuId: string } => {
  if (!raw) {
    const defaultMenu = createMenuProfileState(defaultMenuName);
    return { menus: [defaultMenu], activeMenuId: defaultMenu.id };
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Partial<MenuStorageBundleV2>).version === MENU_STORAGE_VERSION &&
      Array.isArray((parsed as Partial<MenuStorageBundleV2>).menus)
    ) {
      const bundle = parsed as Partial<MenuStorageBundleV2>;
      const normalizedMenus = (bundle.menus || [])
        .map((menu) => menu as Partial<MenuProfileState>)
        .filter((menu) => typeof menu.name === "string" && menu.name.trim().length > 0)
        .map((menu) => ({
          id: typeof menu.id === "string" && menu.id ? menu.id : crypto.randomUUID(),
          name: String(menu.name || "").trim(),
          mealData: normalizeMenuDataRecord(menu.mealData),
          cellPeopleCount: normalizePeopleCountMap(menu.cellPeopleCount),
          cookedStatus: normalizeCookedStatusMap(menu.cookedStatus),
        }));
      if (normalizedMenus.length > 0) {
        const activeId = String(bundle.activeMenuId || "").trim();
        const resolvedActiveId = normalizedMenus.some((menu) => menu.id === activeId)
          ? activeId
          : normalizedMenus[0].id;
        return { menus: normalizedMenus, activeMenuId: resolvedActiveId };
      }
    }

    const legacyMenu = createMenuProfileState(defaultMenuName);
    legacyMenu.mealData = normalizeMenuDataRecord(parsed);
    return { menus: [legacyMenu], activeMenuId: legacyMenu.id };
  } catch {
    const defaultMenu = createMenuProfileState(defaultMenuName);
    return { menus: [defaultMenu], activeMenuId: defaultMenu.id };
  }
};

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
  const startIso = isIsoDate(fallbackStartRaw)
    ? fallbackStartRaw
    : formatDate(getMonday(new Date()));
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
    return parsed.filter((item) => item && typeof item === "object" && typeof item.name === "string" && item.name.trim()).length;
  } catch {
    return 0;
  }
};

export default function SettingsPage() {
  const buildNameDrafts = (menus: MenuProfileState[]): Record<string, string> => {
    const nextDrafts: Record<string, string> = {};
    menus.forEach((menu) => {
      nextDrafts[menu.id] = menu.name;
    });
    return nextDrafts;
  };

  const loadInitialState = (): {
    rangeKey: string;
    menuProfiles: MenuProfileState[];
    activeMenuId: string;
    nameDrafts: Record<string, string>;
    mergeShoppingWithAllMenus: boolean;
    activeProductsCount: number;
  } => {
    if (typeof window === "undefined") {
      return {
        rangeKey: "",
        menuProfiles: [],
        activeMenuId: "",
        nameDrafts: {},
        mergeShoppingWithAllMenus: false,
        activeProductsCount: 0,
      };
    }

    const nextRangeKey = getCurrentRangeKey();
    const parsed = parseMenuBundleFromStorage(
      localStorage.getItem(`${MENU_STORAGE_KEY}:${nextRangeKey}`),
      DEFAULT_MENU_NAME
    );
    const nextDrafts = buildNameDrafts(parsed.menus);
    return {
      rangeKey: nextRangeKey,
      menuProfiles: parsed.menus,
      activeMenuId: parsed.activeMenuId,
      nameDrafts: nextDrafts,
      mergeShoppingWithAllMenus:
        localStorage.getItem(`${MENU_SHOPPING_MERGE_KEY_PREFIX}:${nextRangeKey}`) === "1",
      activeProductsCount: getActiveProductsCount(nextRangeKey),
    };
  };

  const [initialState] = useState(() => loadInitialState());
  const [rangeKey] = useState(initialState.rangeKey);
  const [menuProfiles, setMenuProfiles] = useState<MenuProfileState[]>(initialState.menuProfiles);
  const [activeMenuId, setActiveMenuId] = useState(initialState.activeMenuId);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>(initialState.nameDrafts);
  const [isCreateMenuDialogOpen, setIsCreateMenuDialogOpen] = useState(false);
  const [newMenuNameDraft, setNewMenuNameDraft] = useState("");
  const [mergeShoppingWithAllMenus, setMergeShoppingWithAllMenus] = useState(
    initialState.mergeShoppingWithAllMenus
  );
  const [activeProductsCount] = useState(initialState.activeProductsCount);
  const [dayStructureMode, setDayStructureMode] = useState<DayStructureMode>(() => loadDayStructureMode());
  const [mealSlots, setMealSlots] = useState<MealSlotSetting[]>(() => loadMealSlotsForRange(initialState.rangeKey));
  const [showMealSettingsDialog, setShowMealSettingsDialog] = useState(false);
  const [newMealSlotName, setNewMealSlotName] = useState("");
  const [saveMealSlotsAsDefault, setSaveMealSlotsAsDefault] = useState(false);
  const orderedMealSlots = useMemo(() => [...mealSlots].sort((a, b) => a.order - b.order), [mealSlots]);

  const periodLabel = useMemo(() => {
    if (!rangeKey.includes("__")) return "";
    const [start, end] = rangeKey.split("__");
    return `${formatDisplayDate(start)}-${formatDisplayDate(end)}`;
  }, [rangeKey]);

  const getMenuStorageKey = (nextRangeKey: string) => `${MENU_STORAGE_KEY}:${nextRangeKey}`;
  const getMergeShoppingKey = (nextRangeKey: string) =>
    `${MENU_SHOPPING_MERGE_KEY_PREFIX}:${nextRangeKey}`;

  const persistMenuBundle = (nextMenus: MenuProfileState[], nextActiveMenuId: string) => {
    if (!rangeKey) return;
    const payload: MenuStorageBundleV2 = {
      version: MENU_STORAGE_VERSION,
      activeMenuId: nextActiveMenuId,
      menus: nextMenus,
    };
    localStorage.setItem(getMenuStorageKey(rangeKey), JSON.stringify(payload));
    setMenuProfiles(nextMenus);
    setActiveMenuId(nextActiveMenuId);
  };

  const getCellKey = (day: string, meal: string) => `${day}-${meal}`;

  const migrateMealNameInMenus = (menus: MenuProfileState[], fromName: string, toName: string): MenuProfileState[] => {
    if (!fromName || !toName || fromName === toName) return menus;

    return menus.map((menu) => {
      const nextMealData: Record<string, unknown[]> = { ...menu.mealData };
      Object.entries(menu.mealData).forEach(([cellKey, items]) => {
        const parsed = splitCellKey(cellKey);
        if (!parsed || parsed.mealLabel !== fromName) return;
        const targetKey = getCellKey(parsed.dayKey, toName);
        nextMealData[targetKey] = [...(nextMealData[targetKey] || []), ...(items || [])];
        delete nextMealData[cellKey];
      });

      const nextCellPeopleCount: Record<string, number> = { ...menu.cellPeopleCount };
      Object.entries(menu.cellPeopleCount).forEach(([cellKey, count]) => {
        const parsed = splitCellKey(cellKey);
        if (!parsed || parsed.mealLabel !== fromName) return;
        const targetKey = getCellKey(parsed.dayKey, toName);
        nextCellPeopleCount[targetKey] = count;
        delete nextCellPeopleCount[cellKey];
      });

      return {
        ...menu,
        mealData: nextMealData,
        cellPeopleCount: nextCellPeopleCount,
      };
    });
  };

  const saveMenuName = (menuId: string) => {
    const target = menuProfiles.find((menu) => menu.id === menuId);
    if (!target) return;

    const rawDraft = nameDrafts[menuId] || target.name;
    const normalized = rawDraft.trim().replace(/\s+/g, " ");
    if (!normalized) {
      setNameDrafts((prev) => ({ ...prev, [menuId]: target.name }));
      return;
    }
    if (normalized === target.name) return;

    const duplicate = menuProfiles.some(
      (menu) => menu.id !== menuId && menu.name.toLocaleLowerCase("ru-RU") === normalized.toLocaleLowerCase("ru-RU")
    );
    if (duplicate) return;

    const nextMenus = menuProfiles.map((menu) =>
      menu.id === menuId ? { ...menu, name: normalized } : menu
    );
    persistMenuBundle(nextMenus, activeMenuId);
    setNameDrafts(buildNameDrafts(nextMenus));
  };

  const addMenu = () => {
    const normalized = newMenuNameDraft.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const duplicate = menuProfiles.some(
      (menu) => menu.name.toLocaleLowerCase("ru-RU") === normalized.toLocaleLowerCase("ru-RU")
    );
    if (duplicate) return;

    const created = createMenuProfileState(normalized);
    const nextMenus = [...menuProfiles, created];
    persistMenuBundle(nextMenus, activeMenuId || created.id);
    setNameDrafts(buildNameDrafts(nextMenus));
    setNewMenuNameDraft("");
    setIsCreateMenuDialogOpen(false);
  };

  const removeMenu = (menuId: string) => {
    if (menuProfiles.length <= 1) return;
    const target = menuProfiles.find((menu) => menu.id === menuId);
    if (!target) return;
    if (!confirm(`Удалить меню "${target.name}"?`)) return;

    const nextMenus = menuProfiles.filter((menu) => menu.id !== menuId);
    const nextActiveMenuId = activeMenuId === menuId ? nextMenus[0].id : activeMenuId;
    persistMenuBundle(nextMenus, nextActiveMenuId);
    setNameDrafts(buildNameDrafts(nextMenus));
  };

  const toggleMealVisibility = (slotId: string) => {
    setMealSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, visible: !slot.visible } : slot)));
  };

  const renameMealSlot = (slotId: string, nextRawName: string) => {
    const normalized = normalizeMealSlotName(nextRawName);
    const current = mealSlots.find((slot) => slot.id === slotId);
    if (!current || !normalized || normalized === current.name) return;

    const exists = mealSlots.some(
      (slot) => slot.id !== slotId && slot.name.toLocaleLowerCase("ru-RU") === normalized.toLocaleLowerCase("ru-RU")
    );
    if (exists) return;

    const nextMenus = migrateMealNameInMenus(menuProfiles, current.name, normalized);
    persistMenuBundle(nextMenus, activeMenuId);
    setMealSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, name: normalized } : slot)));
  };

  const moveMealSlot = (slotId: string, direction: -1 | 1) => {
    setMealSlots((prev) => {
      const ordered = [...prev].sort((a, b) => a.order - b.order);
      const index = ordered.findIndex((slot) => slot.id === slotId);
      if (index < 0) return prev;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= ordered.length) return prev;
      const swapped = [...ordered];
      [swapped[index], swapped[nextIndex]] = [swapped[nextIndex], swapped[index]];
      return swapped.map((slot, idx) => ({ ...slot, order: idx }));
    });
  };

  const addMealSlot = () => {
    const normalized = normalizeMealSlotName(newMealSlotName);
    if (!normalized) return;
    const exists = mealSlots.some(
      (slot) => slot.name.toLocaleLowerCase("ru-RU") === normalized.toLocaleLowerCase("ru-RU")
    );
    if (exists) return;

    const nextOrder = mealSlots.length;
    setMealSlots((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: normalized, visible: true, order: nextOrder },
    ]);
    setNewMealSlotName("");
  };

  const closeMealSettingsDialog = () => {
    setShowMealSettingsDialog(false);
    setSaveMealSlotsAsDefault(false);
  };

  const handleMealSettingsDone = () => {
    if (saveMealSlotsAsDefault && typeof window !== "undefined") {
      localStorage.setItem(MEAL_STRUCTURE_DEFAULT_SETTINGS_KEY, JSON.stringify(mealSlots));
    }
    closeMealSettingsDialog();
  };

  useEffect(() => {
    if (!rangeKey) return;
    localStorage.setItem(getMergeShoppingKey(rangeKey), mergeShoppingWithAllMenus ? "1" : "0");
  }, [mergeShoppingWithAllMenus, rangeKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(DAY_STRUCTURE_MODE_KEY, dayStructureMode);
  }, [dayStructureMode]);

  useEffect(() => {
    if (typeof window === "undefined" || !rangeKey) return;
    localStorage.setItem(`${MEAL_STRUCTURE_SETTINGS_KEY}:${rangeKey}`, JSON.stringify(mealSlots));
  }, [mealSlots, rangeKey]);

  return (
    <section className="card">
      <h1 className="h1">Настройки</h1>
      <div id="menu-management" className="card" style={{ marginTop: "12px", padding: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>Настройки меню</h2>
        <p className="muted" style={{ marginTop: "6px" }}>
          Период: {periodLabel || "не выбран"}
        </p>

        <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <input
            type="checkbox"
            checked={mergeShoppingWithAllMenus}
            onChange={(e) => setMergeShoppingWithAllMenus(e.target.checked)}
          />
          Объединять все меню в один список покупок
        </label>

        <div
          style={{
            border: "1px solid var(--border-default)",
            borderRadius: "10px",
            padding: "10px",
            marginBottom: "12px",
            display: "grid",
            gap: "8px",
          }}
        >
          <strong style={{ fontSize: "14px" }}>Структура дня</strong>
          <div
            role="group"
            aria-label="Режим отображения дня"
            style={{
              display: "inline-flex",
              border: "1px solid var(--border-default)",
              borderRadius: "999px",
              padding: "2px",
              width: "fit-content",
            }}
          >
            <button
              type="button"
              className={dayStructureMode === "list" ? "btn btn-primary" : "btn"}
              style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
              onClick={() => setDayStructureMode("list")}
            >
              Список
            </button>
            <button
              type="button"
              className={dayStructureMode === "meals" ? "btn btn-primary" : "btn"}
              style={{ padding: "4px 10px", fontSize: "12px", minHeight: "30px" }}
              onClick={() => setDayStructureMode("meals")}
            >
              По приемам
            </button>
          </div>
          <div>
            <button type="button" className="btn" onClick={() => setShowMealSettingsDialog(true)}>
              Настроить приемы
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: "8px" }}>
          {menuProfiles.map((menu) => (
            <div
              key={menu.id}
              style={{
                display: "grid",
                gap: "8px",
                border: "1px solid var(--border-default)",
                borderRadius: "10px",
                padding: "8px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <input
                  className="input"
                  style={{ minWidth: "180px", maxWidth: "320px", flex: "1 1 220px" }}
                  value={nameDrafts[menu.id] || ""}
                  placeholder="Название меню (редактируется)"
                  aria-label={`Название меню ${menu.name}`}
                  onChange={(e) =>
                    setNameDrafts((prev) => ({
                      ...prev,
                      [menu.id]: e.target.value,
                    }))
                  }
                />
                <button type="button" className="btn btn-primary" onClick={() => saveMenuName(menu.id)}>
                  Сохранить
                </button>
                {menu.id === activeMenuId ? (
                  <span className="muted" style={{ fontSize: "12px" }}>
                    Текущее меню
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  borderTop: "1px solid var(--border-default)",
                  paddingTop: "8px",
                  display: "flex",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  className="btn btn-danger"
                  style={{ padding: "6px 10px" }}
                  onClick={() => removeMenu(menu.id)}
                  disabled={menuProfiles.length <= 1}
                >
                  Удалить меню
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: "12px" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setNewMenuNameDraft("");
              setIsCreateMenuDialogOpen(true);
            }}
          >
            + Добавить меню
          </button>
        </div>
      </div>

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

      {showMealSettingsDialog ? (
        <div className="menu-dialog-overlay" role="dialog" aria-modal="true" aria-label="Настроить приемы">
          <div className="menu-dialog" style={{ maxWidth: "680px" }}>
            <h3 style={{ marginTop: 0, marginBottom: "12px" }}>Настроить приемы</h3>
            <div style={{ display: "grid", gap: "8px" }}>
              {orderedMealSlots.map((slot, index) => (
                <div
                  key={slot.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto auto",
                    gap: "8px",
                    alignItems: "center",
                    border: "1px solid var(--border-default)",
                    borderRadius: "8px",
                    padding: "8px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={slot.visible}
                    onChange={() => toggleMealVisibility(slot.id)}
                    title="Показывать прием"
                  />
                  <input
                    className="input"
                    defaultValue={slot.name}
                    onBlur={(e) => renameMealSlot(slot.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        renameMealSlot(slot.id, (e.target as HTMLInputElement).value);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => moveMealSlot(slot.id, -1)}
                    disabled={index === 0}
                    style={{ padding: "2px 8px" }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => moveMealSlot(slot.id, 1)}
                    disabled={index === orderedMealSlots.length - 1}
                    style={{ padding: "2px 8px" }}
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>

            <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                className="input"
                type="text"
                placeholder="Новый прием"
                value={newMealSlotName}
                onChange={(e) => setNewMealSlotName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addMealSlot();
                }}
                style={{ flex: "1 1 220px" }}
              />
              <button type="button" className="btn btn-primary" onClick={addMealSlot}>
                + Добавить прием
              </button>
            </div>

            <label style={{ marginTop: "12px", display: "inline-flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={saveMealSlotsAsDefault}
                onChange={(e) => setSaveMealSlotsAsDefault(e.target.checked)}
              />
              Использовать по умолчанию
            </label>

            <div className="menu-dialog__actions">
              <button type="button" className="menu-dialog__confirm" onClick={handleMealSettingsDone}>
                Сохранить
              </button>
              <button type="button" className="menu-dialog__cancel" onClick={closeMealSettingsDialog}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCreateMenuDialogOpen ? (
        <div className="menu-dialog-overlay" role="dialog" aria-modal="true" aria-label="Новое меню">
          <div className="menu-dialog" style={{ maxWidth: "420px" }}>
            <h3 style={{ marginTop: 0, marginBottom: "12px" }}>Новое меню</h3>
            <input
              className="menu-dialog__input"
              value={newMenuNameDraft}
              onChange={(e) => setNewMenuNameDraft(e.target.value)}
              placeholder="Название меню"
              autoFocus
            />
            <div className="menu-dialog__actions">
              <button
                type="button"
                className="menu-dialog__confirm"
                onClick={addMenu}
                disabled={!newMenuNameDraft.trim()}
              >
                Создать
              </button>
              <button
                type="button"
                className="menu-dialog__cancel"
                onClick={() => setIsCreateMenuDialogOpen(false)}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
