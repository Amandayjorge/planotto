"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import { resolveRecipeImageForCard } from "../../lib/recipeImageCatalog";
import { decodeRecipeShareBundle } from "../../lib/recipeShareBundle";
import { getRecipeById, type RecipeModel } from "../../lib/recipesSupabase";

export default function SharedRecipesPage() {
  const { t } = useI18n();
  const [rawItemsParam, setRawItemsParam] = useState("");
  const [isQueryReady, setIsQueryReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [recipes, setRecipes] = useState<RecipeModel[]>([]);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setRawItemsParam(String(params.get("items") || "").trim());
    setIsQueryReady(true);
  }, []);

  const shareItems = useMemo(() => {
    return decodeRecipeShareBundle(rawItemsParam);
  }, [rawItemsParam]);

  useEffect(() => {
    let cancelled = false;

    const loadSharedRecipes = async () => {
      if (!isQueryReady) return;
      if (shareItems.length === 0) {
        setRecipes([]);
        setErrorMessage(t("recipes.shareList.invalid"));
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setErrorMessage("");
        const loaded = await Promise.all(
          shareItems.map(async (item) => {
            try {
              return await getRecipeById(item.id, null, item.token);
            } catch {
              return null;
            }
          })
        );

        if (cancelled) return;
        const visible = loaded.filter((item): item is RecipeModel => Boolean(item));
        setRecipes(visible);
        if (visible.length === 0) {
          setErrorMessage(t("recipes.shareList.empty"));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadSharedRecipes();

    return () => {
      cancelled = true;
    };
  }, [isQueryReady, shareItems, t]);

  return (
    <section style={{ padding: "20px", maxWidth: "920px", margin: "0 auto" }}>
      <h1 className="h1" style={{ marginBottom: "10px" }}>
        {t("recipes.shareList.title")}
      </h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: "14px" }}>
        {t("recipes.shareList.description")}
      </p>

      {isLoading ? (
        <div className="card">{t("recipes.shareList.loading")}</div>
      ) : errorMessage ? (
        <div className="card">
          <p style={{ margin: 0 }}>{errorMessage}</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {recipes.map((recipe) => {
            const cardImage = resolveRecipeImageForCard({
              id: recipe.id,
              title: recipe.title,
              image: recipe.image,
              type: recipe.type,
              isTemplate: recipe.isTemplate,
            });
            const item = shareItems.find((row) => row.id === recipe.id);
            const token = String(item?.token || "").trim();
            const openHref = token
              ? `/recipes/${encodeURIComponent(recipe.id)}?share=${encodeURIComponent(token)}`
              : `/recipes/${encodeURIComponent(recipe.id)}`;
            return (
              <article key={recipe.id} className="card" style={{ textAlign: "left" }}>
                <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
                  {cardImage ? (
                    <img
                      src={cardImage}
                      alt={recipe.title}
                      style={{ width: "84px", height: "84px", borderRadius: "10px", objectFit: "cover", flexShrink: 0 }}
                    />
                  ) : null}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 style={{ margin: 0 }}>{recipe.title}</h3>
                    {recipe.shortDescription ? (
                      <p
                        className="muted"
                        style={{
                          marginTop: "6px",
                          marginBottom: "10px",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {recipe.shortDescription}
                      </p>
                    ) : null}
                    <Link href={openHref} className="btn btn-primary">
                      {t("recipes.shareList.openRecipe")}
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
