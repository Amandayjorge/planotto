"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { SUPABASE_UNAVAILABLE_MESSAGE, getSupabaseClient, isSupabaseConfigured } from "../lib/supabaseClient";
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
const PROFILE_GOAL_OPTIONS = [
  { value: "menu", label: "Планировать меню" },
  { value: "recipes", label: "Рецепты и поиск" },
  { value: "shopping", label: "Список покупок" },
  { value: "explore", label: "Пока просто смотрю" },
];
const PROFILE_MEALS_OPTIONS = [
  { value: "1-2", label: "1-2" },
  { value: "3", label: "3" },
  { value: "4+", label: "4+" },
  { value: "variable", label: "По-разному" },
];
const PROFILE_PLAN_DAYS_OPTIONS = [
  { value: "all", label: "Все дни" },
  { value: "weekdays", label: "Будни" },
  { value: "weekends", label: "Выходные" },
];
const PROFILE_DIET_OPTIONS = [
  { value: "none", label: "Без ограничений" },
  { value: "vegetarian", label: "Вегетарианское" },
  { value: "vegan", label: "Веганское" },
  { value: "gluten_free", label: "Без глютена" },
  { value: "lactose_free", label: "Без лактозы" },
  { value: "pp", label: "ПП" },
];

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

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const supabase = getSupabaseClient();

    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email || null);
      setProfileName(resolveUserName(data.user));
      setProfileAvatar(resolveUserAvatar(data.user));
      setProfileFrame(resolveUserFrame(data.user));
      setProfileGoal(resolveUserMetaValue(data.user, "goal", "menu"));
      setProfilePeopleCount(resolveUserMetaValue(data.user, "people_count_default", "2"));
      setProfileMealsPerDay(resolveUserMetaValue(data.user, "meals_per_day", "3"));
      setProfilePlanDays(resolveUserMetaValue(data.user, "plan_days", "all"));
      setProfileDiet(resolveUserMetaValue(data.user, "diet_type", "none"));
      setProfileAllergiesList(parseItemsList(resolveUserMetaValue(data.user, "allergies", "")));
      setProfileDislikesList(parseItemsList(resolveUserMetaValue(data.user, "dislikes", "")));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user?.email || null);
      setProfileName(resolveUserName(session?.user));
      setProfileAvatar(resolveUserAvatar(session?.user));
      setProfileFrame(resolveUserFrame(session?.user));
      setProfileGoal(resolveUserMetaValue(session?.user, "goal", "menu"));
      setProfilePeopleCount(resolveUserMetaValue(session?.user, "people_count_default", "2"));
      setProfileMealsPerDay(resolveUserMetaValue(session?.user, "meals_per_day", "3"));
      setProfilePlanDays(resolveUserMetaValue(session?.user, "plan_days", "all"));
      setProfileDiet(resolveUserMetaValue(session?.user, "diet_type", "none"));
      setProfileAllergiesList(parseItemsList(resolveUserMetaValue(session?.user, "allergies", "")));
      setProfileDislikesList(parseItemsList(resolveUserMetaValue(session?.user, "dislikes", "")));
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async () => {
    if (!isSupabaseConfigured()) {
      setMessage(SUPABASE_UNAVAILABLE_MESSAGE);
      return;
    }
    if (!email.trim() || !password.trim()) {
      setMessage("Введите email и пароль.");
      return;
    }

    setLoading(true);
    setMessage("");
    const supabase = getSupabaseClient();

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setMessage("Вход выполнен.");
        router.push("/recipes");
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage("Регистрация выполнена. Если включено подтверждение, проверьте email.");
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "Ошибка авторизации.";
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
          avatar_frame: profileFrame.trim(),
          goal: profileGoal,
          people_count_default: profilePeopleCount,
          meals_per_day: profileMealsPerDay,
          plan_days: profilePlanDays,
          diet_type: profileDiet,
          allergies: serializeItemsList(profileAllergiesList),
          dislikes: serializeItemsList(profileDislikesList),
        },
      });

      if (error) throw error;
      setMessage("Профиль сохранен.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось сохранить профиль.";
      setMessage(text);
    } finally {
      setProfileSaving(false);
    }
  };

  const handleAvatarFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setMessage("Выберите файл изображения.");
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
    setMessage("Вы вышли из аккаунта.");
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

  const previewInitial = useMemo(() => {
    const base = profileName.trim() || (userEmail || "").split("@")[0] || "Г";
    return base.charAt(0).toUpperCase();
  }, [profileName, userEmail]);

  return (
    <section className="card" style={{ maxWidth: "560px", margin: "0 auto" }}>
      <h1 className="h1">Аккаунт</h1>

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
                    inset: 0,
                    overflow: "hidden",
                    borderRadius: "0",
                  }}
                >
                  <img
                    src={profileAvatar}
                    alt="Текущий аватар"
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
              {profileFrame ? (
                <img
                  src={profileFrame}
                  alt="Рамка аватара"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    objectPosition: "center",
                    pointerEvents: "none",
                  }}
                />
              ) : null}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "20px", color: "var(--text-primary)" }}>
                {profileName.trim() || "Без имени"}
              </div>
              <div className="muted">{userEmail}</div>
            </div>
          </div>

          <label style={{ display: "grid", gap: "6px" }}>
            Ваше имя
            <input
              className="input"
              type="text"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="Например, Катя"
            />
          </label>

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
              Использование сервиса <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>(по желанию)</span>
            </div>
            <div className="muted" style={{ margin: 0, fontSize: "13px" }}>
              Эти настройки помогают давать рекомендации, но не обязательны.
            </div>
            <label style={{ display: "grid", gap: "6px" }}>
              Цель использования
              <select className="input" value={profileGoal} onChange={(e) => setProfileGoal(e.target.value)}>
                {PROFILE_GOAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ fontSize: "12px", color: "var(--text-tertiary)", marginTop: "-2px" }}>
              Используется для рекомендаций и подсказок.
            </div>
            <label style={{ display: "grid", gap: "6px" }}>
              Планировать дни
              <select className="input" value={profilePlanDays} onChange={(e) => setProfilePlanDays(e.target.value)}>
                {PROFILE_PLAN_DAYS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "6px" }}>
              Обычно готовлю на
              <select className="input" value={profilePeopleCount} onChange={(e) => setProfilePeopleCount(e.target.value)}>
                {["1", "2", "3", "4", "5+"].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "6px" }}>
              Приемов пищи в день
              <select className="input" value={profileMealsPerDay} onChange={(e) => setProfileMealsPerDay(e.target.value)}>
                {PROFILE_MEALS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
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
              Питание и предпочтения <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>(по желанию)</span>
            </div>
            <label style={{ display: "grid", gap: "6px" }}>
              Тип питания
              <select className="input" value={profileDiet} onChange={(e) => setProfileDiet(e.target.value)}>
                {PROFILE_DIET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ fontSize: "12px", color: "var(--text-tertiary)", display: "grid", gap: "3px" }}>
              <div>Аллергии и строгие ограничения — никогда не использовать.</div>
              <div>Не люблю — стараемся избегать в рекомендациях.</div>
            </div>

            <div style={{ display: "grid", gap: "6px" }}>
              <span>Аллергии и строгие ограничения</span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 260px", minWidth: "220px" }}>
                  <ProductAutocompleteInput
                    value={allergyInput}
                    onChange={setAllergyInput}
                    suggestions={productSuggestions}
                    placeholder="Например: арахис"
                  />
                </div>
                <button type="button" className="btn" onClick={() => addListItem(allergyInput, setProfileAllergiesList, setAllergyInput)}>
                  Добавить
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
              <span>Не люблю продукты</span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 260px", minWidth: "220px" }}>
                  <ProductAutocompleteInput
                    value={dislikeInput}
                    onChange={setDislikeInput}
                    suggestions={productSuggestions}
                    placeholder="Например: лук"
                  />
                </div>
                <button type="button" className="btn" onClick={() => addListItem(dislikeInput, setProfileDislikesList, setDislikeInput)}>
                  Добавить
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
              gap: "8px",
              padding: "12px",
              border: "1px solid var(--border-default)",
              borderRadius: "12px",
              background: "var(--background-primary)",
            }}
          >
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
              Внешний вид <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>(по желанию)</span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
              Не влияет на рекомендации и работу меню.
            </div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>Выберите аватар</div>
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
                  title="Выбрать аватар"
                >
                  <img
                    src={src}
                    alt="Аватар"
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
                Загрузить фото
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarFileChange}
                  style={{ display: "none" }}
                />
              </label>
              <button type="button" className="btn" onClick={() => setProfileAvatar("")}>
                Убрать аватар
              </button>
            </div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>Рамка</div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setProfileFrame("")}
                style={{
                  border: !profileFrame ? "2px solid var(--accent-primary)" : "1px solid var(--border-default)",
                }}
              >
                Без рамки
              </button>
              {FRAME_PRESETS.map((src) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setProfileFrame(src)}
                  style={{
                    border: profileFrame === src ? "2px solid var(--accent-primary)" : "1px solid var(--border-default)",
                    borderRadius: "10px",
                    background: "var(--background-primary)",
                    padding: "4px",
                    cursor: "pointer",
                    width: "86px",
                    height: "86px",
                  }}
                  title="Выбрать рамку"
                >
                  <img
                    src={src}
                    alt="Рамка"
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

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" className="btn btn-primary" onClick={handleSaveProfile} disabled={profileSaving}>
              {profileSaving ? "Сохраняем..." : "Сохранить профиль"}
            </button>
            <button type="button" className="btn" onClick={() => router.push("/recipes")} style={{ opacity: 0.95 }}>
              К рецептам
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
              Выйти
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className={`btn ${mode === "signin" ? "btn-primary" : ""}`}
              onClick={() => setMode("signin")}
            >
              Вход
            </button>
            <button
              type="button"
              className={`btn ${mode === "signup" ? "btn-primary" : ""}`}
              onClick={() => setMode("signup")}
            >
              Регистрация
            </button>
          </div>

          <label style={{ display: "grid", gap: "6px" }}>
            Email
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            Пароль
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
              {loading ? "Подождите..." : mode === "signin" ? "Войти" : "Зарегистрироваться"}
            </button>
            <button type="button" className="btn" onClick={() => router.push("/recipes")}>
              Назад
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
