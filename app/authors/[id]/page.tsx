"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useI18n } from "../../components/I18nProvider";
import {
  getPublicAuthorProfile,
  listPublicRecipesByAuthor,
  type PublicAuthorProfile,
  type RecipeLanguage,
  type RecipeModel,
} from "../../lib/recipesSupabase";
import { resolveRecipeImageForCard } from "../../lib/recipeImageCatalog";

function normalizeRecipeLanguage(value: unknown): RecipeLanguage {
  return value === "ru" || value === "en" || value === "es" ? value : "ru";
}

function resolveRecipeLanguageFromLocale(locale: string): RecipeLanguage {
  const normalized = String(locale || "").toLowerCase();
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("en")) return "en";
  return "ru";
}

function getRecipeLocalizedContent(
  recipe: RecipeModel,
  language: RecipeLanguage
): {
  title: string;
  shortDescription: string;
} {
  const baseLanguage = normalizeRecipeLanguage(recipe.baseLanguage);
  const preferred = recipe.translations?.[language];
  const fallback = recipe.translations?.[baseLanguage];

  return {
    title: (preferred?.title || fallback?.title || recipe.title || "").trim(),
    shortDescription: (preferred?.shortDescription || fallback?.shortDescription || recipe.shortDescription || "").trim(),
  };
}

export default function AuthorPage() {
  const router = useRouter();
  const params = useParams();
  const { locale, t } = useI18n();
  const authorId = String(params.id || "").trim();
  const uiRecipeLanguage = useMemo(() => resolveRecipeLanguageFromLocale(locale), [locale]);

  const [isLoading, setIsLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [author, setAuthor] = useState<PublicAuthorProfile | null>(null);
  const [recipes, setRecipes] = useState<RecipeModel[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setErrorText("");
      try {
        const [profile, publicRecipes] = await Promise.all([
          getPublicAuthorProfile(authorId),
          listPublicRecipesByAuthor(authorId),
        ]);

        if (cancelled) return;
        setAuthor(profile);
        setRecipes(publicRecipes);

        if (!profile && publicRecipes.length === 0) {
          setErrorText(t("recipes.authors.notFound"));
        }
      } catch (error) {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : t("recipes.authors.loadFailed");
        setErrorText(text);
      } finally {
        if (cancelled) return;
        setIsLoading(false);
      }
    };

    if (!authorId) {
      setIsLoading(false);
      setErrorText(t("recipes.authors.notFound"));
      return () => {
        cancelled = true;
      };
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [authorId, t]);

  const authorName =
    (author?.displayName || "").trim()
    || (authorId === "system" ? t("recipes.card.planottoAuthor") : t("recipes.card.authorUnknown"));
  const authorInitial = authorName.charAt(0).toUpperCase() || "A";
  const recipeCount = Math.max(author?.recipeCount || 0, recipes.length);

  if (isLoading) {
    return (
        <section className="card" style={{ maxWidth: "900px", margin: "0 auto", padding: "20px" }}>
        <h1 className="h1">{t("recipes.authors.loading")}</h1>
      </section>
    );
  }

  if (errorText) {
    return (
      <section className="card" style={{ maxWidth: "900px", margin: "0 auto", padding: "20px" }}>
        <h1 className="h1">{t("recipes.authors.title")}</h1>
        <p className="muted">{errorText}</p>
        <button className="btn" onClick={() => router.push("/recipes")}>
          {t("recipes.authors.backToRecipes")}
        </button>
      </section>
    );
  }

  return (
    <section style={{ maxWidth: "900px", margin: "0 auto", padding: "20px" }}>
      <div className="card" style={{ marginBottom: "14px", padding: "16px" }}>
        <button className="btn" onClick={() => router.push("/recipes")} style={{ marginBottom: "12px" }}>
          {t("recipes.authors.backToRecipes")}
        </button>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          {author?.avatarUrl ? (
            <img
              src={author.avatarUrl}
              alt={t("recipes.authors.avatarAlt")}
              style={{
                width: "64px",
                height: "64px",
                borderRadius: "50%",
                objectFit: "cover",
                border: "1px solid var(--border-default)",
              }}
            />
          ) : (
            <div
              aria-hidden
              style={{
                width: "64px",
                height: "64px",
                borderRadius: "50%",
                border: "1px solid var(--border-default)",
                display: "grid",
                placeItems: "center",
                fontWeight: 700,
                fontSize: "24px",
                color: "var(--text-primary)",
                background: "var(--background-secondary)",
              }}
            >
              {authorInitial}
            </div>
          )}
          <div>
            <h1 className="h2" style={{ margin: 0 }}>{authorName}</h1>
            <p className="muted" style={{ margin: "4px 0 0 0" }}>
              {t("recipes.authors.recipesCount", { count: recipeCount })}
            </p>
          </div>
        </div>
      </div>

      <h2 className="h3" style={{ marginBottom: "10px" }}>{t("recipes.authors.publicRecipesTitle")}</h2>
      {recipes.length === 0 ? (
        <div className="card" style={{ padding: "14px" }}>
          <p className="muted" style={{ margin: 0 }}>{t("recipes.authors.noPublicRecipes")}</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {recipes.map((recipe) => {
            const localized = getRecipeLocalizedContent(recipe, uiRecipeLanguage);
            const title = localized.title || recipe.title || t("menu.fallback.recipeTitle");
            const description = localized.shortDescription || "";
            const image = resolveRecipeImageForCard({
              id: recipe.id,
              title: recipe.title,
              image: recipe.image,
              type: recipe.type,
              isTemplate: recipe.isTemplate,
            });
            return (
              <div key={recipe.id} className="card" style={{ textAlign: "left" }}>
                <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
                  {image ? (
                    <img
                      src={image}
                      alt={title}
                      style={{
                        width: "86px",
                        height: "86px",
                        borderRadius: "10px",
                        objectFit: "cover",
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 style={{ margin: 0 }}>{title}</h3>
                    <p className="muted" style={{ margin: "4px 0 0 0" }}>
                      {t("recipes.card.servings", { count: recipe.servings || 2 })}
                    </p>
                    {description ? (
                      <p style={{ margin: "8px 0 0 0", color: "var(--text-secondary)" }}>{description}</p>
                    ) : null}
                    <div style={{ marginTop: "10px" }}>
                      <button className="btn btn-primary" onClick={() => router.push(`/recipes/${recipe.id}`)}>
                        {t("recipes.authors.openRecipe")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
