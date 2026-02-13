import NewRecipeForm from "./NewRecipeForm";

interface NewRecipePageProps {
  searchParams?: {
    firstCreate?: string;
  };
}

export default function NewRecipePage({ searchParams }: NewRecipePageProps) {
  const initialFirstCreate = searchParams?.firstCreate === "1";
  return <NewRecipeForm initialFirstCreate={initialFirstCreate} />;
}
