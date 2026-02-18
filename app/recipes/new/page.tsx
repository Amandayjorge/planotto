import NewRecipeForm from "./NewRecipeForm";

interface NewRecipePageProps {
  searchParams?: Promise<{
    firstCreate?: string | string[];
  }>;
}

export default async function NewRecipePage({ searchParams }: NewRecipePageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};

  const firstCreateRaw = resolvedSearchParams?.firstCreate;
  const firstCreate = Array.isArray(firstCreateRaw) ? firstCreateRaw[0] : firstCreateRaw;
  const initialFirstCreate = firstCreate === "1";

  return <NewRecipeForm initialFirstCreate={initialFirstCreate} />;
}
