"use client";

import { getSupabaseClient } from "./supabaseClient";

export type MenuWeekVisibility = "private" | "public";

export interface WeeklyMenuPayload {
  weekStart: string;
  mealData: Record<string, unknown>;
  cellPeopleCount: Record<string, number>;
  cookedStatus: Record<string, boolean>;
  visibility: MenuWeekVisibility;
}

interface WeeklyMenuRow {
  id: string;
  owner_id: string;
  week_start: string;
  meal_data: Record<string, unknown> | null;
  cell_people_count: Record<string, number> | null;
  cooked_status: Record<string, boolean> | null;
  visibility: MenuWeekVisibility | null;
  updated_at: string | null;
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

export interface PublicWeekSummary {
  id: string;
  ownerId: string;
  weekStart: string;
  updatedAt: string | null;
}

const WEEK_MENU_COLUMNS =
  "id,owner_id,week_start,meal_data,cell_people_count,cooked_status,visibility,updated_at";

const isMissingRelationError = (error: unknown, relationName: string): boolean => {
  if (!error || typeof error !== "object") return false;
  const typed = error as PostgrestLikeError;
  const message = String(typed.message || "").toLowerCase();
  const relation = relationName.toLowerCase();
  return typed.code === "42P01" || message.includes(relation) || message.includes("does not exist");
};

const mapRowToPayload = (row: WeeklyMenuRow): WeeklyMenuPayload => ({
  weekStart: row.week_start,
  mealData: row.meal_data || {},
  cellPeopleCount: row.cell_people_count || {},
  cookedStatus: row.cooked_status || {},
  visibility: row.visibility || "private",
});

export const getMineWeekMenu = async (
  ownerId: string,
  weekStart: string
): Promise<WeeklyMenuPayload | null> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("weekly_menus")
    .select(WEEK_MENU_COLUMNS)
    .eq("owner_id", ownerId)
    .eq("week_start", weekStart)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, "weekly_menus")) return null;
    throw error;
  }

  if (!data) return null;
  return mapRowToPayload(data as WeeklyMenuRow);
};

export const upsertMineWeekMenu = async (
  ownerId: string,
  payload: WeeklyMenuPayload
): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("weekly_menus").upsert(
    {
      owner_id: ownerId,
      week_start: payload.weekStart,
      meal_data: payload.mealData || {},
      cell_people_count: payload.cellPeopleCount || {},
      cooked_status: payload.cookedStatus || {},
      visibility: payload.visibility || "private",
    },
    { onConflict: "owner_id,week_start" }
  );

  if (error) {
    throw error;
  }
};

export const listPublicWeekSummaries = async (
  excludeOwnerId?: string | null
): Promise<PublicWeekSummary[]> => {
  const supabase = getSupabaseClient();
  let query = supabase
    .from("weekly_menus")
    .select("id,owner_id,week_start,updated_at")
    .eq("visibility", "public")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (excludeOwnerId) {
    query = query.neq("owner_id", excludeOwnerId);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error, "weekly_menus")) return [];
    throw error;
  }

  return ((data || []) as WeeklyMenuRow[]).map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    weekStart: row.week_start,
    updatedAt: row.updated_at || null,
  }));
};

export const getPublicWeekMenuById = async (
  id: string
): Promise<(WeeklyMenuPayload & { ownerId: string; id: string }) | null> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("weekly_menus")
    .select(WEEK_MENU_COLUMNS)
    .eq("id", id)
    .eq("visibility", "public")
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, "weekly_menus")) return null;
    throw error;
  }

  if (!data) return null;
  const row = data as WeeklyMenuRow;
  return {
    ...mapRowToPayload(row),
    ownerId: row.owner_id,
    id: row.id,
  };
};

export const copyPublicWeekToMine = async (
  ownerId: string,
  publicWeekId: string
): Promise<string | null> => {
  const source = await getPublicWeekMenuById(publicWeekId);
  if (!source) return null;

  await upsertMineWeekMenu(ownerId, {
    weekStart: source.weekStart,
    mealData: source.mealData || {},
    cellPeopleCount: source.cellPeopleCount || {},
    cookedStatus: source.cookedStatus || {},
    visibility: "private",
  });

  return source.weekStart;
};

