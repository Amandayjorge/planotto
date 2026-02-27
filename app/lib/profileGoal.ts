"use client";

export const PROFILE_GOAL_STORAGE_KEY = "planottoProfileGoal";

export type ProfileGoal = "menu" | "recipes" | "shopping" | "explore";

export const normalizeProfileGoal = (value: unknown): ProfileGoal => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "recipes") return "recipes";
  if (raw === "shopping") return "shopping";
  if (raw === "explore") return "explore";
  return "menu";
};

export const getPrimaryRouteByProfileGoal = (goal: ProfileGoal): string => {
  if (goal === "recipes") return "/recipes";
  if (goal === "shopping") return "/shopping-list";
  if (goal === "explore") return "/recipes";
  return "/menu";
};

export const readProfileGoalFromStorage = (): ProfileGoal => {
  if (typeof window === "undefined") return "menu";
  return normalizeProfileGoal(window.localStorage.getItem(PROFILE_GOAL_STORAGE_KEY));
};

export const saveProfileGoalToStorage = (goal: unknown): void => {
  if (typeof window === "undefined") return;
  const normalized = normalizeProfileGoal(goal);
  window.localStorage.setItem(PROFILE_GOAL_STORAGE_KEY, normalized);
};

export const clearProfileGoalFromStorage = (): void => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PROFILE_GOAL_STORAGE_KEY);
};

