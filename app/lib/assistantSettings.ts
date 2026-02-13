export const ASSISTANT_AVATAR_KEY = "planottoAssistantAvatar";
const ASSISTANT_AVATAR_CHANGED_EVENT = "planotto-assistant-avatar-changed";

export const ASSISTANT_AVATAR_OPTIONS = [
  "/mascot/pages/auth.png",
  "/mascot/pages/home.png",
  "/mascot/pages/recipes.png",
  "/mascot/pages/menu.png",
  "/mascot/pages/pantry.png",
  "/mascot/pages/shopping-list.png",
] as const;

export type AssistantAvatarOption = (typeof ASSISTANT_AVATAR_OPTIONS)[number];

export const DEFAULT_ASSISTANT_AVATAR: AssistantAvatarOption = "/mascot/pages/auth.png";

const isValidAssistantAvatar = (value: string): value is AssistantAvatarOption => {
  return (ASSISTANT_AVATAR_OPTIONS as readonly string[]).includes(value);
};

export const getAssistantAvatarChangedEventName = () => ASSISTANT_AVATAR_CHANGED_EVENT;

export const loadAssistantAvatarSetting = (): AssistantAvatarOption => {
  if (typeof window === "undefined") return DEFAULT_ASSISTANT_AVATAR;

  const raw = localStorage.getItem(ASSISTANT_AVATAR_KEY) || "";
  return isValidAssistantAvatar(raw) ? raw : DEFAULT_ASSISTANT_AVATAR;
};

export const saveAssistantAvatarSetting = (value: string) => {
  if (typeof window === "undefined") return;

  const next = isValidAssistantAvatar(value) ? value : DEFAULT_ASSISTANT_AVATAR;
  localStorage.setItem(ASSISTANT_AVATAR_KEY, next);
  window.dispatchEvent(new CustomEvent(ASSISTANT_AVATAR_CHANGED_EVENT, { detail: next }));
};
