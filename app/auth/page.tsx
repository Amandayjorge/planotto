"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { SUPABASE_UNAVAILABLE_MESSAGE, getSupabaseClient, isSupabaseConfigured } from "../lib/supabaseClient";
import { ensureCurrentUserProfile } from "../lib/adminSupabase";
import { useI18n } from "../components/I18nProvider";
import { isLocale } from "../lib/i18n";
import { isPaidFeatureEnabled } from "../lib/subscription";
import { usePlanTier } from "../lib/usePlanTier";
import ProductAutocompleteInput from "../components/ProductAutocompleteInput";
import { appendProductSuggestions, loadProductSuggestions } from "../lib/productSuggestions";

type Mode = "signin" | "signup";
const AVATAR_PRESETS = [
  "/avatar/presets/m.png",
  "/avatar/presets/w.png",
  "/avatar/presets/c.png",
  "/avatar/presets/d.png",
  "/avatar/presets/h.png",
];
const FRAME_PRESETS = [
  "/avatar/frames/thumbs/1.png",
  "/avatar/frames/thumbs/2.png",
  "/avatar/frames/thumbs/5.png",
];
const PROFILE_GOAL_OPTIONS = ["menu", "recipes", "shopping", "explore"] as const;
const PROFILE_MEALS_OPTIONS = ["1-2", "3", "4+", "variable"] as const;
const PROFILE_PLAN_DAYS_OPTIONS = ["all", "weekdays", "weekends"] as const;
const PROFILE_DIET_OPTIONS = ["none", "vegetarian", "vegan", "gluten_free", "lactose_free", "pp"] as const;

const parseItemsList = (raw: string): string[] => {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const chunk of raw.split(/[,\n;]+/)) {
    const value = chunk.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(value);
  }
  return items;
};

const serializeItemsList = (items: string[]): string => items.join(", ");

const resolveUserName = (user: User | null | undefined): string => {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const rawName =
    metadata.full_name ?? metadata.name ?? metadata.nickname ?? metadata.user_name;

  if (typeof rawName === "string" && rawName.trim()) {
    return rawName.trim();
  }

  const email = user?.email || "";
  const firstPart = email.split("@")[0] || "";
  const normalized = firstPart.replace(/[._-]+/g, " ").trim();
  if (!normalized) return "";

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const resolveUserAvatar = (user: User | null | undefined): string => {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const rawAvatar = metadata.avatar_url ?? metadata.picture;
  if (typeof rawAvatar === "string") return rawAvatar.trim();
  return "";
};

const resolveUserFrame = (user: User | null | undefined): string => {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const rawFrame = metadata.avatar_frame;
  if (typeof rawFrame === "string") return rawFrame.trim();
  return "";
};

const resolveUserMetaValue = (user: User | null | undefined, key: string, fallback = ""): string => {
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const raw = metadata[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return fallback;
};

export default function AuthPage() {
  const router = useRouter();
  const { locale, locales, setLocale, t } = useI18n();
  const { planTier } = usePlanTier();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileAvatar, setProfileAvatar] = useState("");
  const [profileFrame, setProfileFrame] = useState("");
  const [profileGoal, setProfileGoal] = useState("menu");
  const [profilePeopleCount, setProfilePeopleCount] = useState("2");
  const [profileMealsPerDay, setProfileMealsPerDay] = useState("3");
  const [profilePlanDays, setProfilePlanDays] = useState("all");
  const [profileDiet, setProfileDiet] = useState("none");
  const [profileAllergiesList, setProfileAllergiesList] = useState<string[]>([]);
  const [profileDislikesList, setProfileDislikesList] = useState<string[]>([]);
  const [allergyInput, setAllergyInput] = useState("");
  const [dislikeInput, setDislikeInput] = useState("");
  const [productSuggestions, setProductSuggestions] = useState<string[]>(() => loadProductSuggestions());
  const [loading, setLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [message, setMessage] = useState("");
  const canUseAvatarFrames = isPaidFeatureEnabled(planTier, "avatar_frames");

  const languageOptions = useMemo(
    () =>
      locales.map((code) => ({
        value: code,
        label: t(`languages.${code}`),
      })),
    [locales, t]
  );

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const supabase = getSupabaseClient();

    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email || null);
      setProfileName(resolveUserName(data.user));
      setProfileAvatar(resolveUserAvatar(data.user));
      setProfileFrame(resolveUserFrame(data.user));
      const userLocale = resolveUserMetaValue(data.user, "ui_language", "");
      if (isLocale(userLocale)) setLocale(userLocale);
      setProfileGoal(resolveUserMetaValue(data.user, "goal", "menu"));
      setProfilePeopleCount(resolveUserMetaValue(data.user, "people_count_default", "2"));
      setProfileMealsPerDay(resolveUserMetaValue(data.user, "meals_per_day", "3"));
      setProfilePlanDays(resolveUserMetaValue(data.user, "plan_days", "all"));
      setProfileDiet(resolveUserMetaValue(data.user, "diet_type", "none"));
      setProfileAllergiesList(parseItemsList(resolveUserMetaValue(data.user, "allergies", "")));
      setProfileDislikesList(parseItemsList(resolveUserMetaValue(data.user, "dislikes", "")));
      void ensureCurrentUserProfile();
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user?.email || null);
      setProfileName(resolveUserName(session?.user));
      setProfileAvatar(resolveUserAvatar(session?.user));
      setProfileFrame(resolveUserFrame(session?.user));
      const userLocale = resolveUserMetaValue(session?.user, "ui_language", "");
      if (isLocale(userLocale)) setLocale(userLocale);
      setProfileGoal(resolveUserMetaValue(session?.user, "goal", "menu"));
      setProfilePeopleCount(resolveUserMetaValue(session?.user, "people_count_default", "2"));
      setProfileMealsPerDay(resolveUserMetaValue(session?.user, "meals_per_day", "3"));
      setProfilePlanDays(resolveUserMetaValue(session?.user, "plan_days", "all"));
      setProfileDiet(resolveUserMetaValue(session?.user, "diet_type", "none"));
      setProfileAllergiesList(parseItemsList(resolveUserMetaValue(session?.user, "allergies", "")));
      setProfileDislikesList(parseItemsList(resolveUserMetaValue(session?.user, "dislikes", "")));
      void ensureCurrentUserProfile();
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, [setLocale]);

  useEffect(() => {
    if (canUseAvatarFrames) return;
    if (!profileFrame) return;
    setProfileFrame("");
  }, [canUseAvatarFrames, profileFrame]);

  const handleSubmit = async () => {
    if (!isSupabaseConfigured()) {
      setMessage(SUPABASE_UNAVAILABLE_MESSAGE);
      return;
    }
    if (!email.trim() || !password.trim()) {
      setMessage(t("auth.messages.enterEmailPassword"));
      return;
    }

    setLoading(true);
    setMessage("");
    const supabase = getSupabaseClient();

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setMessage(t("auth.messages.signedIn"));
        router.push("/recipes");
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage(t("auth.messages.registered"));
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : t("auth.messages.authError");
      setMessage(text);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!isSupabaseConfigured() || !userEmail) return;

    setProfileSaving(true);
    setMessage("");
    const supabase = getSupabaseClient();

    try {
      const { error } = await supabase.auth.updateUser({
        data: {
          full_name: profileName.trim(),
          avatar_url: profileAvatar.trim(),
          avatar_frame: (canUseAvatarFrames ? profileFrame : "").trim(),
          goal: profileGoal,
          people_count_default: profilePeopleCount,
          meals_per_day: profileMealsPerDay,
          plan_days: profilePlanDays,
          diet_type: profileDiet,
          ui_language: locale,
          allergies: serializeItemsList(profileAllergiesList),
          dislikes: serializeItemsList(profileDislikesList),
        },
      });

      if (error) throw error;
      await ensureCurrentUserProfile();
      setMessage(t("auth.messages.profileSaved"));
    } catch (error) {
      const text = error instanceof Error ? error.message : t("auth.messages.profileSaveError");
      setMessage(text);
    } finally {
      setProfileSaving(false);
    }
  };

  const handleAvatarFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setMessage(t("auth.messages.invalidImage"));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) return;
      setProfileAvatar(result);
      setMessage("");
    };
    reader.readAsDataURL(file);
  };

  const handleSignOut = async () => {
    if (!isSupabaseConfigured()) return;
    const supabase = getSupabaseClient();
    await supabase.auth.signOut();
    setMessage(t("auth.messages.signedOut"));
    setProfileName("");
    setProfileAvatar("");
    setProfileFrame("");
  };

  const addListItem = (
    raw: string,
    setter: Dispatch<SetStateAction<string[]>>,
    inputSetter: Dispatch<SetStateAction<string>>
  ) => {
    const value = raw.trim();
    if (!value) return;
    setter((prev) => {
      if (prev.some((item) => item.toLowerCase() === value.toLowerCase())) return prev;
      return [...prev, value];
    });
    appendProductSuggestions([value]);
    setProductSuggestions(loadProductSuggestions());
    inputSetter("");
  };

  const removeListItem = (value: string, setter: Dispatch<SetStateAction<string[]>>) => {
    setter((prev) => prev.filter((item) => item !== value));
  };

  const effectiveProfileFrame = canUseAvatarFrames ? profileFrame : "";

  const previewInitial = useMemo(() => {
    const base = profileName.trim() || (userEmail || "").split("@")[0] || "G";
    return base.charAt(0).toUpperCase();
  }, [profileName, userEmail]);

  return (
    <section className="card" style={{ maxWidth: "560px", margin: "0 auto" }}>
      <h1 className="h1">{t("auth.title")}</h1>

      {userEmail ? (
        <div style={{ display: "grid", gap: "14px" }}>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <div
              aria-hidden
              style={{
                width: "132px",
                height: "132px",
                borderRadius: "50%",
                border: "1px solid var(--border-default)",
                backgroundColor: "var(--background-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "30px",
                fontWeight: 700,
                color: "var(--text-primary)",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {profileAvatar ? (
                <span
                  style={{
                    position: "absolute",
                    inset: effectiveProfileFrame ? "16px" : 0,
                    overflow: "hidden",
                    borderRadius: effectiveProfileFrame ? "16px" : "0",
                  }}
                >
                  <img
                    src={profileAvatar}
                    alt={t("auth.profile.currentAvatarAlt")}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      objectPosition: "center center",
                    }}
                  />
                </span>
              ) : (
                previewInitial
              )}
              {effectiveProfileFrame ? (
                <img
                  src={effectiveProfileFrame}
                  alt={t("auth.profile.currentFrameAlt")}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: "center",
                    transform: "scale(1.14)",
                    transformOrigin: "center",
                    pointerEvents: "none",
                  }}
                />
              ) : null}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "20px", color: "var(--text-primary)" }}>
                {profileName.trim() || t("auth.profile.noName")}
              </div>
              <div className="muted">{userEmail}</div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: "10px",
              padding: "12px",
              border: "1px solid var(--border-default)",
              borderRadius: "12px",
              background: "var(--background-primary)",
            }}
          >
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
              {t("auth.profile.section")}
            </div>
            <label style={{ display: "grid", gap: "6px" }}>
              {t("auth.profile.nameLabel")}
              <input
                className="input"
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder={t("auth.profile.namePlaceholder")}
              />
            </label>
            <label style={{ display: "grid", gap: "6px" }}>
              {t("auth.language.label")}
              <select
                className="input"
                value={locale}
                onChange={(event) => {
                  if (isLocale(event.target.value)) {
                    setLocale(event.target.value);
                  }
                }}
              >
                {languageOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{t("auth.profile.avatarTitle")}</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{t("auth.profile.avatarPresetTitle")}</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
                gap: "8px",
              }}
            >
              {AVATAR_PRESETS.map((src) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setProfileAvatar(src)}
                  style={{
                    border: profileAvatar === src ? "2px solid var(--accent-primary)" : "1px solid var(--border-default)",
                    borderRadius: "10px",
                    background: "var(--background-primary)",
                    padding: "6px",
                    cursor: "pointer",
                    minHeight: "102px",
                  }}
                  title={t("auth.profile.pickAvatar")}
                >
                  <img
                    src={src}
                    alt={t("auth.profile.avatarAlt")}
                    style={{
                      width: "100%",
                      height: "84px",
                      objectFit: "cover",
                      objectPosition: "center 20%",
                      borderRadius: "8px",
                      display: "block",
                    }}
                  />
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <label className="btn" style={{ cursor: "pointer" }}>
                {t("auth.profile.uploadPhoto")}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarFileChange}
                  style={{ display: "none" }}
                />
              </label>
              <button type="button" className="btn" onClick={() => setProfileAvatar("")}>
                {t("auth.profile.removeAvatar")}
              </button>
            </div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{t("auth.profile.frameTitle")}</div>
            {!canUseAvatarFrames ? (
              <p className="muted" style={{ margin: "0" }}>
                {t("subscription.locks.avatarFrames")}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setProfileFrame("")}
                style={{
                  border: !effectiveProfileFrame ? "2px solid var(--accent-primary)" : "1px solid var(--border-default)",
                }}
              >
                {t("auth.profile.noFrame")}
              </button>
              {FRAME_PRESETS.map((src) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => {
                    if (!canUseAvatarFrames) return;
                    setProfileFrame(src);
                  }}
                  disabled={!canUseAvatarFrames}
                  style={{
                    border: effectiveProfileFrame === src ? "2px solid var(--accent-primary)" : "1px solid var(--border-default)",
                    borderRadius: "10px",
                    background: "var(--background-primary)",
                    padding: "4px",
                    cursor: canUseAvatarFrames ? "pointer" : "not-allowed",
                    opacity: canUseAvatarFrames ? 1 : 0.5,
                    width: "86px",
                    height: "86px",
                  }}
                  title={t("auth.profile.pickFrame")}
                >
                  <img
                    src={src}
                    alt={t("auth.profile.frameAlt")}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      objectPosition: "center",
                      borderRadius: "8px",
                      display: "block",
                    }}
                  />
                </button>
              ))}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: "10px",
              padding: "12px",
              border: "1px solid var(--border-default)",
              borderRadius: "12px",
              background: "var(--background-primary)",
            }}
          >
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
              {t("auth.preferences.section")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-tertiary)", display: "grid", gap: "3px" }}>
              <div>{t("auth.preferences.infoAllergies")}</div>
              <div>{t("auth.preferences.infoDislikes")}</div>
            </div>
            <label style={{ display: "grid", gap: "6px" }}>
              {t("auth.preferences.dietType")}
              <select className="input" value={profileDiet} onChange={(e) => setProfileDiet(e.target.value)}>
                {PROFILE_DIET_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`auth.options.diet.${value}`)}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ display: "grid", gap: "6px" }}>
              <span>{t("auth.preferences.allergies")}</span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 260px", minWidth: "220px" }}>
                  <ProductAutocompleteInput
                    value={allergyInput}
                    onChange={setAllergyInput}
                    suggestions={productSuggestions}
                    placeholder={t("auth.preferences.allergyPlaceholder")}
                  />
                </div>
                <button type="button" className="btn" onClick={() => addListItem(allergyInput, setProfileAllergiesList, setAllergyInput)}>
                  {t("auth.preferences.add")}
                </button>
              </div>
              {profileAllergiesList.length > 0 ? (
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {profileAllergiesList.map((item) => (
                    <span
                      key={`allergy-${item}`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        border: "1px solid var(--border-default)",
                        borderRadius: "999px",
                        padding: "4px 10px",
                        background: "var(--background-primary)",
                      }}
                    >
                      {item}
                      <button type="button" className="btn" onClick={() => removeListItem(item, setProfileAllergiesList)} style={{ padding: "0 6px" }}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={{ display: "grid", gap: "6px" }}>
              <span>{t("auth.preferences.dislikes")}</span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 260px", minWidth: "220px" }}>
                  <ProductAutocompleteInput
                    value={dislikeInput}
                    onChange={setDislikeInput}
                    suggestions={productSuggestions}
                    placeholder={t("auth.preferences.dislikePlaceholder")}
                  />
                </div>
                <button type="button" className="btn" onClick={() => addListItem(dislikeInput, setProfileDislikesList, setDislikeInput)}>
                  {t("auth.preferences.add")}
                </button>
              </div>
              {profileDislikesList.length > 0 ? (
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {profileDislikesList.map((item) => (
                    <span
                      key={`dislike-${item}`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        border: "1px solid var(--border-default)",
                        borderRadius: "999px",
                        padding: "4px 10px",
                        background: "var(--background-primary)",
                      }}
                    >
                      {item}
                      <button type="button" className="btn" onClick={() => removeListItem(item, setProfileDislikesList)} style={{ padding: "0 6px" }}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: "10px",
              padding: "12px",
              border: "1px solid var(--border-default)",
              borderRadius: "12px",
              background: "var(--background-primary)",
            }}
          >
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
              {t("auth.serviceUsage.section")}
            </div>
            <label style={{ display: "grid", gap: "6px" }}>
              {t("auth.serviceUsage.goal")}
              <select className="input" value={profileGoal} onChange={(e) => setProfileGoal(e.target.value)}>
                {PROFILE_GOAL_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`auth.options.goal.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "6px" }}>
              {t("auth.serviceUsage.days")}
              <select className="input" value={profilePlanDays} onChange={(e) => setProfilePlanDays(e.target.value)}>
                {PROFILE_PLAN_DAYS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`auth.options.planDays.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "6px" }}>
              {t("auth.serviceUsage.mealsPerDay")}
              <select className="input" value={profileMealsPerDay} onChange={(e) => setProfileMealsPerDay(e.target.value)}>
                {PROFILE_MEALS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`auth.options.mealsPerDay.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" className="btn btn-primary" onClick={handleSaveProfile} disabled={profileSaving}>
              {profileSaving ? t("auth.actions.savingProfile") : t("auth.actions.saveProfile")}
            </button>
            <button type="button" className="btn" onClick={() => router.push("/recipes")} style={{ opacity: 0.95 }}>
              {t("auth.actions.toRecipes")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleSignOut}
              style={{
                background: "transparent",
                borderColor: "transparent",
                color: "var(--text-tertiary)",
                textDecoration: "underline",
                textUnderlineOffset: "2px",
              }}
            >
              {t("auth.actions.signOut")}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          <label style={{ display: "grid", gap: "6px" }}>
            {t("auth.language.label")}
            <select
              className="input"
              value={locale}
              onChange={(event) => {
                if (isLocale(event.target.value)) {
                  setLocale(event.target.value);
                }
              }}
            >
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className={`btn ${mode === "signin" ? "btn-primary" : ""}`}
              onClick={() => setMode("signin")}
            >
              {t("auth.actions.signInTab")}
            </button>
            <button
              type="button"
              className={`btn ${mode === "signup" ? "btn-primary" : ""}`}
              onClick={() => setMode("signup")}
            >
              {t("auth.actions.signUpTab")}
            </button>
          </div>

          <label style={{ display: "grid", gap: "6px" }}>
            {t("auth.actions.email")}
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            {t("auth.actions.password")}
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
              {loading
                ? t("auth.actions.pleaseWait")
                : mode === "signin"
                  ? t("auth.actions.signIn")
                  : t("auth.actions.signUp")}
            </button>
            <button type="button" className="btn" onClick={() => router.push("/recipes")}>
              {t("auth.actions.back")}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className="muted" style={{ marginTop: "12px" }}>
          {message}
        </p>
      )}
    </section>
  );
}
