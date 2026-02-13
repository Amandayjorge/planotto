"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function RecipeViewRedirectPage() {
  const router = useRouter();
  const params = useParams();
  const recipeId = String(params.id || "");

  useEffect(() => {
    if (!recipeId) {
      router.replace("/recipes");
      return;
    }
    router.replace(`/recipes/${recipeId}`);
  }, [recipeId, router]);

  return (
    <div style={{ padding: "20px", textAlign: "center" }}>
      Переход к рецепту...
    </div>
  );
}
