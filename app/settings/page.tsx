"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const MENU_STORAGE_KEY = "weeklyMenu";
const RANGE_STATE_KEY = "selectedMenuRange";
const WEEK_START_KEY = "selectedWeekStart";
const MENU_SHOPPING_MERGE_KEY_PREFIX = "menuShoppingMerge";
const MENU_STORAGE_VERSION = 2;
const DEFAULT_MENU_NAME = "Меню 1";

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
  name: name.trim() || DEFAULT_MENU_NAME,
  mealData: {},
  cellPeopleCount: {},
  cookedStatus: {},
});

const parseMenuBundleFromStorage = (
  raw: string | null
): { menus: MenuProfileState[]; activeMenuId: string } => {
  if (!raw) {
    const defaultMenu = createMenuProfileState(DEFAULT_MENU_NAME);
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

    const legacyMenu = createMenuProfileState(DEFAULT_MENU_NAME);
    legacyMenu.mealData = normalizeMenuDataRecord(parsed);
    return { menus: [legacyMenu], activeMenuId: legacyMenu.id };
  } catch {
    const defaultMenu = createMenuProfileState(DEFAULT_MENU_NAME);
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
  } => {
    if (typeof window === "undefined") {
      return {
        rangeKey: "",
        menuProfiles: [],
        activeMenuId: "",
        nameDrafts: {},
        mergeShoppingWithAllMenus: false,
      };
    }

    const nextRangeKey = getCurrentRangeKey();
    const parsed = parseMenuBundleFromStorage(localStorage.getItem(`${MENU_STORAGE_KEY}:${nextRangeKey}`));
    const nextDrafts = buildNameDrafts(parsed.menus);
    return {
      rangeKey: nextRangeKey,
      menuProfiles: parsed.menus,
      activeMenuId: parsed.activeMenuId,
      nameDrafts: nextDrafts,
      mergeShoppingWithAllMenus:
        localStorage.getItem(`${MENU_SHOPPING_MERGE_KEY_PREFIX}:${nextRangeKey}`) === "1",
    };
  };

  const [initialState] = useState(() => loadInitialState());
  const [rangeKey] = useState(initialState.rangeKey);
  const [menuProfiles, setMenuProfiles] = useState<MenuProfileState[]>(initialState.menuProfiles);
  const [activeMenuId, setActiveMenuId] = useState(initialState.activeMenuId);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>(initialState.nameDrafts);
  const [newMenuName, setNewMenuName] = useState("");
  const [mergeShoppingWithAllMenus, setMergeShoppingWithAllMenus] = useState(
    initialState.mergeShoppingWithAllMenus
  );

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
    const normalized = newMenuName.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const duplicate = menuProfiles.some(
      (menu) => menu.name.toLocaleLowerCase("ru-RU") === normalized.toLocaleLowerCase("ru-RU")
    );
    if (duplicate) return;

    const created = createMenuProfileState(normalized);
    const nextMenus = [...menuProfiles, created];
    persistMenuBundle(nextMenus, activeMenuId || created.id);
    setNameDrafts(buildNameDrafts(nextMenus));
    setNewMenuName("");
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

  useEffect(() => {
    if (!rangeKey) return;
    localStorage.setItem(getMergeShoppingKey(rangeKey), mergeShoppingWithAllMenus ? "1" : "0");
  }, [mergeShoppingWithAllMenus, rangeKey]);

  return (
    <section className="card">
      <h1 className="h1">Настройки</h1>
      <div id="menu-management" className="card" style={{ marginTop: "12px", padding: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>Управление меню</h2>
        <p className="muted" style={{ marginTop: "6px" }}>
          Период: {periodLabel || "не выбран"}
        </p>

        <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <input
            type="checkbox"
            checked={mergeShoppingWithAllMenus}
            onChange={(e) => setMergeShoppingWithAllMenus(e.target.checked)}
          />
          Объединять со всеми меню при формировании списка покупок
        </label>

        <div style={{ display: "grid", gap: "8px" }}>
          {menuProfiles.map((menu) => (
            <div
              key={menu.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
                border: "1px solid var(--border-default)",
                borderRadius: "10px",
                padding: "8px",
              }}
            >
              <input
                className="input"
                style={{ minWidth: "180px", maxWidth: "320px" }}
                value={nameDrafts[menu.id] || ""}
                onChange={(e) =>
                  setNameDrafts((prev) => ({
                    ...prev,
                    [menu.id]: e.target.value,
                  }))
                }
              />
              <button type="button" className="btn" onClick={() => saveMenuName(menu.id)}>
                Сохранить
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => removeMenu(menu.id)}
                disabled={menuProfiles.length <= 1}
              >
                Удалить
              </button>
              {menu.id === activeMenuId ? (
                <span className="muted" style={{ fontSize: "12px" }}>
                  Текущее меню
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ minWidth: "180px", maxWidth: "320px" }}
            value={newMenuName}
            onChange={(e) => setNewMenuName(e.target.value)}
            placeholder="Новое меню"
          />
          <button type="button" className="btn" onClick={addMenu} disabled={!newMenuName.trim()}>
            + Добавить меню
          </button>
        </div>
      </div>

      <div style={{ marginTop: "12px" }}>
        <Link href="/menu" className="btn">
          ← Назад в меню
        </Link>
      </div>
    </section>
  );
}
