export const SUPPORT_EMAIL = "support@planotto.app";

const encodeSubject = (value: string): string => encodeURIComponent(value.trim());

export const getSupportMailto = (subject?: string): string => {
  const normalized = String(subject || "").trim();
  if (!normalized) return `mailto:${SUPPORT_EMAIL}`;
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeSubject(normalized)}`;
};
