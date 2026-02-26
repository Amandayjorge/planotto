"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseClient, isSupabaseConfigured, SUPABASE_UNAVAILABLE_MESSAGE } from "../lib/supabaseClient";
import {
  bulkUpdateRecipes,
  createIngredient,
  ensureCurrentUserProfile,
  grantTestProAccess,
  isCurrentUserAdmin,
  loadAdminIngredients,
  loadAdminRecipes,
  loadAdminUserProfiles,
  mergeIngredientInto,
  updateAdminUserProfile,
  updateIngredientCategory,
  upsertIngredientTranslation,
  type AdminIngredient,
  type AdminIngredientCategory,
  type AdminLanguage,
  type AdminRecipe,
  type AdminSubscriptionStatus,
  type AdminUserProfile,
} from "../lib/adminSupabase";

type LanguageFilter = "all" | AdminLanguage;
type VisibilityFilter = "all" | "private" | "public" | "link" | "invited";
type MissingTranslationFilter = "all" | "missing_any" | AdminLanguage;

const LANGUAGES: AdminLanguage[] = ["ru", "en", "es"];
const SUBSCRIPTION_STATUSES: AdminSubscriptionStatus[] = ["inactive", "trial", "active", "past_due", "canceled"];
const VISIBILITY_OPTIONS: Array<"private" | "public" | "link" | "invited"> = ["private", "public", "link", "invited"];

const formatDateTime = (value: string): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
};

const toInputDateTimeLocal = (value: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localTime.toISOString().slice(0, 16);
};

const fromInputDateTimeLocal = (value: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
};

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const [recipes, setRecipes] = useState<AdminRecipe[]>([]);
  const [ingredients, setIngredients] = useState<AdminIngredient[]>([]);
  const [ingredientCategories, setIngredientCategories] = useState<AdminIngredientCategory[]>([]);
  const [profiles, setProfiles] = useState<AdminUserProfile[]>([]);

  const [recipeLanguageFilter, setRecipeLanguageFilter] = useState<LanguageFilter>("all");
  const [recipeVisibilityFilter, setRecipeVisibilityFilter] = useState<VisibilityFilter>("all");
  const [recipeMissingFilter, setRecipeMissingFilter] = useState<MissingTranslationFilter>("all");
  const [selectedRecipeIds, setSelectedRecipeIds] = useState<string[]>([]);
  const [bulkBaseLanguage, setBulkBaseLanguage] = useState<AdminLanguage>("ru");
  const [bulkVisibility, setBulkVisibility] = useState<"private" | "public" | "link" | "invited">("private");

  const [ingredientCategoryFilter, setIngredientCategoryFilter] = useState<string>("all");
  const [newIngredientId, setNewIngredientId] = useState("");
  const [newIngredientCategory, setNewIngredientCategory] = useState("other");
  const [mergeSourceIngredient, setMergeSourceIngredient] = useState("");
  const [mergeTargetIngredient, setMergeTargetIngredient] = useState("");

  const loadAllData = async (): Promise<void> => {
    if (!isSupabaseConfigured()) {
      setErrorMessage(SUPABASE_UNAVAILABLE_MESSAGE);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage("");

    try {
      const supabase = getSupabaseClient();
      const { data: userData } = await supabase.auth.getUser();
      setAdminEmail(userData.user?.email || "");

      await ensureCurrentUserProfile();

      const admin = await isCurrentUserAdmin();
      setIsAdmin(admin);

      if (!admin) {
        setLoading(false);
        return;
      }

      const [loadedRecipes, loadedIngredients, loadedProfiles] = await Promise.all([
        loadAdminRecipes(),
        loadAdminIngredients(),
        loadAdminUserProfiles(),
      ]);

      setRecipes(loadedRecipes);
      setIngredients(loadedIngredients.ingredients);
      setIngredientCategories(loadedIngredients.categories);
      setProfiles(loadedProfiles);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось загрузить данные админки.";
      setErrorMessage(text);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAllData();
  }, []);

  const filteredRecipes = useMemo(() => {
    return recipes.filter((recipe) => {
      if (
        recipeLanguageFilter !== "all"
        && recipe.baseLanguage !== recipeLanguageFilter
        && !recipe.translationLanguages.includes(recipeLanguageFilter)
      ) {
        return false;
      }

      if (recipeVisibilityFilter !== "all" && recipe.visibility !== recipeVisibilityFilter) {
        return false;
      }

      if (recipeMissingFilter === "missing_any" && recipe.missingTranslations.length === 0) {
        return false;
      }
      if (recipeMissingFilter !== "all" && recipeMissingFilter !== "missing_any") {
        if (!recipe.missingTranslations.includes(recipeMissingFilter)) {
          return false;
        }
      }

      return true;
    });
  }, [recipeLanguageFilter, recipeMissingFilter, recipeVisibilityFilter, recipes]);

  const filteredIngredients = useMemo(() => {
    return ingredients.filter((ingredient) => {
      if (ingredientCategoryFilter === "all") return true;
      return ingredient.categoryId === ingredientCategoryFilter;
    });
  }, [ingredientCategoryFilter, ingredients]);

  const allFilteredRecipesSelected = useMemo(() => {
    if (filteredRecipes.length === 0) return false;
    return filteredRecipes.every((recipe) => selectedRecipeIds.includes(recipe.id));
  }, [filteredRecipes, selectedRecipeIds]);

  const setRecipeSelected = (recipeId: string, value: boolean) => {
    setSelectedRecipeIds((prev) => {
      if (value) {
        if (prev.includes(recipeId)) return prev;
        return [...prev, recipeId];
      }
      return prev.filter((item) => item !== recipeId);
    });
  };

  const toggleSelectAllFilteredRecipes = () => {
    if (allFilteredRecipesSelected) {
      setSelectedRecipeIds((prev) => prev.filter((item) => !filteredRecipes.some((recipe) => recipe.id === item)));
      return;
    }
    setSelectedRecipeIds((prev) => {
      const next = new Set(prev);
      filteredRecipes.forEach((recipe) => next.add(recipe.id));
      return Array.from(next);
    });
  };

  const applyBulkRecipeUpdate = async (mode: "base_language" | "visibility") => {
    if (selectedRecipeIds.length === 0) {
      setErrorMessage("Выберите рецепты для массового изменения.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await bulkUpdateRecipes(
        selectedRecipeIds,
        mode === "base_language"
          ? { baseLanguage: bulkBaseLanguage }
          : { visibility: bulkVisibility }
      );
      setRecipes(await loadAdminRecipes());
      setSuccessMessage("Массовое обновление рецептов выполнено.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось выполнить массовое обновление.";
      setErrorMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const setIngredientField = (ingredientId: string, language: AdminLanguage, value: string) => {
    setIngredients((prev) => prev.map((ingredient) => (
      ingredient.id === ingredientId
        ? { ...ingredient, names: { ...ingredient.names, [language]: value } }
        : ingredient
    )));
  };

  const setIngredientCategory = (ingredientId: string, categoryId: string) => {
    setIngredients((prev) => prev.map((ingredient) => (
      ingredient.id === ingredientId
        ? { ...ingredient, categoryId }
        : ingredient
    )));
  };

  const saveIngredient = async (ingredient: AdminIngredient) => {
    setBusy(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await updateIngredientCategory(ingredient.id, ingredient.categoryId);
      await Promise.all(
        LANGUAGES.map((language) => upsertIngredientTranslation(ingredient.id, language, ingredient.names[language]))
      );
      setSuccessMessage(`Ингредиент ${ingredient.id} сохранен.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось сохранить ингредиент.";
      setErrorMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateIngredient = async () => {
    const normalizedId = newIngredientId.trim();
    if (!normalizedId) {
      setErrorMessage("Укажите id нового ингредиента.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await createIngredient(normalizedId, newIngredientCategory);
      const loaded = await loadAdminIngredients();
      setIngredients(loaded.ingredients);
      setIngredientCategories(loaded.categories);
      setNewIngredientId("");
      setSuccessMessage(`Ингредиент ${normalizedId} создан.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось создать ингредиент.";
      setErrorMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const handleMergeIngredients = async () => {
    const sourceId = mergeSourceIngredient.trim();
    const targetId = mergeTargetIngredient.trim();
    if (!sourceId || !targetId) {
      setErrorMessage("Укажите source и target ingredient id.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const affectedRecipes = await mergeIngredientInto(sourceId, targetId);
      const [loadedIngredients, loadedRecipes] = await Promise.all([
        loadAdminIngredients(),
        loadAdminRecipes(),
      ]);
      setIngredients(loadedIngredients.ingredients);
      setIngredientCategories(loadedIngredients.categories);
      setRecipes(loadedRecipes);
      setMergeSourceIngredient("");
      setMergeTargetIngredient("");
      setSuccessMessage(`Дубли объединены. Обновлено рецептов: ${affectedRecipes}.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось объединить ингредиенты.";
      setErrorMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const setUserProfileField = <K extends keyof AdminUserProfile>(
    userId: string,
    field: K,
    value: AdminUserProfile[K]
  ) => {
    setProfiles((prev) => prev.map((profile) => (
      profile.userId === userId
        ? { ...profile, [field]: value }
        : profile
    )));
  };

  const saveUserProfile = async (profile: AdminUserProfile) => {
    setBusy(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await updateAdminUserProfile(profile.userId, {
        planTier: profile.planTier,
        subscriptionStatus: profile.subscriptionStatus,
        isBlocked: profile.isBlocked,
        isTestAccess: profile.isTestAccess,
        proExpiresAt: profile.proExpiresAt || "",
        uiLanguage: profile.uiLanguage,
      });
      setSuccessMessage(`Пользователь ${profile.email} обновлен.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось обновить пользователя.";
      setErrorMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const handleGrantTest = async (profile: AdminUserProfile) => {
    setBusy(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await grantTestProAccess(profile.userId, 14);
      setProfiles(await loadAdminUserProfiles());
      setSuccessMessage(`Тестовый Pro доступ выдан: ${profile.email}.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не удалось выдать тестовый доступ.";
      setErrorMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const adminSqlSnippet = adminEmail
    ? `insert into public.admin_users (email, note)\nvalues ('${adminEmail}', 'owner')\non conflict (email) do nothing;`
    : "insert into public.admin_users (email, note)\nvalues ('you@example.com', 'owner')\non conflict (email) do nothing;";

  return (
    <section className="card" style={{ display: "grid", gap: "14px" }}>
      <div>
        <h1 className="h1" style={{ marginBottom: "6px" }}>Админка Planotto</h1>
        <p className="muted">Рецепты, ингредиенты, пользователи и подписка в одном месте.</p>
      </div>

      {loading ? <p className="muted">Загрузка...</p> : null}
      {errorMessage ? <p className="muted" style={{ color: "#9a3d2f" }}>{errorMessage}</p> : null}
      {successMessage ? <p className="muted" style={{ color: "#2d6a4f" }}>{successMessage}</p> : null}

      {!loading && !isAdmin ? (
        <div className="card" style={{ background: "var(--background-secondary)", display: "grid", gap: "10px" }}>
          <div style={{ fontWeight: 700 }}>Нет доступа к админке</div>
          <div className="muted">Добавьте ваш email в таблицу `public.admin_users` через Supabase SQL Editor:</div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", background: "var(--background-primary)", padding: "10px", borderRadius: "8px", border: "1px solid var(--border-default)" }}>{adminSqlSnippet}</pre>
          <button type="button" className="btn btn-primary" onClick={() => void loadAllData()} disabled={busy}>
            Проверить доступ снова
          </button>
        </div>
      ) : null}

      {!loading && isAdmin ? (
        <div style={{ display: "grid", gap: "18px" }}>
          <section className="card" style={{ display: "grid", gap: "12px" }}>
            <h2 style={{ margin: 0 }}>1) Управление рецептами</h2>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <select className="input" style={{ maxWidth: "220px" }} value={recipeLanguageFilter} onChange={(e) => setRecipeLanguageFilter(e.target.value as LanguageFilter)}>
                <option value="all">Язык: все</option>
                {LANGUAGES.map((language) => (
                  <option key={`recipe-lang-${language}`} value={language}>Язык: {language.toUpperCase()}</option>
                ))}
              </select>
              <select className="input" style={{ maxWidth: "240px" }} value={recipeVisibilityFilter} onChange={(e) => setRecipeVisibilityFilter(e.target.value as VisibilityFilter)}>
                <option value="all">Видимость: любая</option>
                {VISIBILITY_OPTIONS.map((visibility) => (
                  <option key={`recipe-vis-${visibility}`} value={visibility}>{visibility}</option>
                ))}
              </select>
              <select className="input" style={{ maxWidth: "260px" }} value={recipeMissingFilter} onChange={(e) => setRecipeMissingFilter(e.target.value as MissingTranslationFilter)}>
                <option value="all">Переводы: все</option>
                <option value="missing_any">Есть пропуски перевода</option>
                {LANGUAGES.map((language) => (
                  <option key={`missing-${language}`} value={language}>Нет перевода {language.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button type="button" className="btn" onClick={toggleSelectAllFilteredRecipes}>
                {allFilteredRecipesSelected ? "Снять выбор с фильтра" : "Выбрать все по фильтру"}
              </button>
              <select className="input" style={{ maxWidth: "180px" }} value={bulkBaseLanguage} onChange={(e) => setBulkBaseLanguage(e.target.value as AdminLanguage)}>
                {LANGUAGES.map((language) => (
                  <option key={`bulk-base-${language}`} value={language}>Base: {language.toUpperCase()}</option>
                ))}
              </select>
              <button type="button" className="btn btn-primary" onClick={() => void applyBulkRecipeUpdate("base_language")} disabled={busy}>
                Массово: base language
              </button>
              <select className="input" style={{ maxWidth: "180px" }} value={bulkVisibility} onChange={(e) => setBulkVisibility(e.target.value as "private" | "public" | "link" | "invited")}>
                {VISIBILITY_OPTIONS.map((visibility) => (
                  <option key={`bulk-visibility-${visibility}`} value={visibility}>{visibility}</option>
                ))}
              </select>
              <button type="button" className="btn" onClick={() => void applyBulkRecipeUpdate("visibility")} disabled={busy}>
                Массово: visibility
              </button>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "880px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Выбор</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Рецепт</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Base</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Видимость</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Переводы</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Нет переводов</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Обновлен</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecipes.map((recipe) => (
                    <tr key={recipe.id}>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <input
                          type="checkbox"
                          checked={selectedRecipeIds.includes(recipe.id)}
                          onChange={(e) => setRecipeSelected(recipe.id, e.target.checked)}
                        />
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <div style={{ fontWeight: 600 }}>{recipe.title || recipe.id}</div>
                        <div className="muted" style={{ fontSize: "12px" }}>{recipe.id}</div>
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>{recipe.baseLanguage.toUpperCase()}</td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>{recipe.visibility}</td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        {recipe.translationLanguages.length > 0 ? recipe.translationLanguages.map((lang) => lang.toUpperCase()).join(", ") : "—"}
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        {recipe.missingTranslations.length > 0 ? recipe.missingTranslations.map((lang) => lang.toUpperCase()).join(", ") : "—"}
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>{formatDateTime(recipe.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" style={{ display: "grid", gap: "12px" }}>
            <h2 style={{ margin: 0 }}>2) Управление ингредиентами</h2>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <input
                className="input"
                style={{ maxWidth: "220px" }}
                value={newIngredientId}
                onChange={(e) => setNewIngredientId(e.target.value)}
                placeholder="new ingredient id"
              />
              <select className="input" style={{ maxWidth: "200px" }} value={newIngredientCategory} onChange={(e) => setNewIngredientCategory(e.target.value)}>
                {ingredientCategories.map((category) => (
                  <option key={`new-category-${category.id}`} value={category.id}>
                    {category.id}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-primary" onClick={() => void handleCreateIngredient()} disabled={busy}>
                Добавить ингредиент
              </button>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <input
                className="input"
                style={{ maxWidth: "220px" }}
                value={mergeSourceIngredient}
                onChange={(e) => setMergeSourceIngredient(e.target.value)}
                placeholder="source ingredient id"
              />
              <input
                className="input"
                style={{ maxWidth: "220px" }}
                value={mergeTargetIngredient}
                onChange={(e) => setMergeTargetIngredient(e.target.value)}
                placeholder="target ingredient id"
              />
              <button type="button" className="btn" onClick={() => void handleMergeIngredients()} disabled={busy}>
                Объединить дубли
              </button>
            </div>
            <select className="input" style={{ maxWidth: "260px" }} value={ingredientCategoryFilter} onChange={(e) => setIngredientCategoryFilter(e.target.value)}>
              <option value="all">Категория: все</option>
              {ingredientCategories.map((category) => (
                <option key={`filter-category-${category.id}`} value={category.id}>
                  {category.id}
                </option>
              ))}
            </select>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "980px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>ingredient_id</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Категория</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>RU</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>EN</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>ES</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIngredients.map((ingredient) => (
                    <tr key={ingredient.id}>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)", whiteSpace: "nowrap" }}>{ingredient.id}</td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <select
                          className="input"
                          value={ingredient.categoryId}
                          onChange={(e) => setIngredientCategory(ingredient.id, e.target.value)}
                        >
                          {ingredientCategories.map((category) => (
                            <option key={`category-${ingredient.id}-${category.id}`} value={category.id}>
                              {category.id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <input
                          className="input"
                          value={ingredient.names.ru}
                          onChange={(e) => setIngredientField(ingredient.id, "ru", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <input
                          className="input"
                          value={ingredient.names.en}
                          onChange={(e) => setIngredientField(ingredient.id, "en", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <input
                          className="input"
                          value={ingredient.names.es}
                          onChange={(e) => setIngredientField(ingredient.id, "es", e.target.value)}
                        />
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <button type="button" className="btn btn-primary" onClick={() => void saveIngredient(ingredient)} disabled={busy}>
                          Сохранить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" style={{ display: "grid", gap: "12px" }}>
            <h2 style={{ margin: 0 }}>3) Управление пользователями</h2>
            <div className="muted">Пользователи появляются после входа в систему (таблица `user_profiles`).</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "1080px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Email</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>UI язык</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Тариф</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Статус</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Блок</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Test access</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Pro до</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border-default)" }}>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((profile) => (
                    <tr key={profile.userId}>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <div style={{ fontWeight: 600 }}>{profile.email}</div>
                        <div className="muted" style={{ fontSize: "12px" }}>{profile.userId}</div>
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <select
                          className="input"
                          value={profile.uiLanguage}
                          onChange={(e) => setUserProfileField(profile.userId, "uiLanguage", e.target.value as AdminLanguage)}
                        >
                          {LANGUAGES.map((language) => (
                            <option key={`ui-language-${profile.userId}-${language}`} value={language}>{language.toUpperCase()}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <select
                          className="input"
                          value={profile.planTier}
                          onChange={(e) => setUserProfileField(profile.userId, "planTier", e.target.value as "free" | "pro")}
                        >
                          <option value="free">free</option>
                          <option value="pro">pro</option>
                        </select>
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <select
                          className="input"
                          value={profile.subscriptionStatus}
                          onChange={(e) => setUserProfileField(profile.userId, "subscriptionStatus", e.target.value as AdminSubscriptionStatus)}
                        >
                          {SUBSCRIPTION_STATUSES.map((status) => (
                            <option key={`sub-status-${profile.userId}-${status}`} value={status}>{status}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={profile.isBlocked}
                          onChange={(e) => setUserProfileField(profile.userId, "isBlocked", e.target.checked)}
                        />
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={profile.isTestAccess}
                          onChange={(e) => setUserProfileField(profile.userId, "isTestAccess", e.target.checked)}
                        />
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <input
                          className="input"
                          type="datetime-local"
                          value={toInputDateTimeLocal(profile.proExpiresAt)}
                          onChange={(e) => setUserProfileField(profile.userId, "proExpiresAt", fromInputDateTimeLocal(e.target.value))}
                        />
                      </td>
                      <td style={{ padding: "8px", borderBottom: "1px solid var(--border-default)" }}>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                          <button type="button" className="btn btn-primary" onClick={() => void saveUserProfile(profile)} disabled={busy}>
                            Сохранить
                          </button>
                          <button type="button" className="btn" onClick={() => void handleGrantTest(profile)} disabled={busy}>
                            Тест Pro 14 дн
                          </button>
                        </div>
                        <div className="muted" style={{ marginTop: "6px", fontSize: "12px" }}>
                          Updated: {formatDateTime(profile.updatedAt)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" style={{ display: "grid", gap: "8px" }}>
            <h2 style={{ margin: 0 }}>4) Управление подпиской</h2>
            <div className="muted">
              Через таблицу пользователей можно вручную включить/выключить Pro, изменить статус подписки и выдать тестовый доступ.
            </div>
            <button type="button" className="btn" onClick={() => void loadAllData()} disabled={busy}>
              Обновить данные админки
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}
