"use strict";

const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config({ path: path.resolve(process.cwd(), process.env.ENV_PATH || ".env") });

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be provided in .env");
  process.exit(1);
}

const SEED_RECIPE_IDS = [
  "seed-omelet-vegetables",
  "seed-oatmeal-fruits",
  "seed-chicken-rice",
  "seed-baked-fish-potatoes",
  "seed-pasta-tomato",
  "seed-tuna-salad",
  "seed-oladi-kefir",
  "seed-greek-yogurt-granola",
  "seed-buckwheat-mushrooms",
  "seed-mashed-potatoes",
  "seed-vegetable-soup",
  "seed-fried-rice-egg",
  "seed-turkey-sandwich",
  "seed-cottage-cheese-berries",
  "seed-roasted-vegetables",
  "seed-lentil-soup",
  "seed-chicken-noodle-soup",
  "seed-rice-vegetables",
  "seed-crepes-milk",
  "seed-tuna-pasta-creamy",
];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const buildPayload = () =>
  SEED_RECIPE_IDS.map((id) => ({
    id,
    is_official: true,
    owner_id: null,
    author_id: null,
    image: null,
  }));

const run = async () => {
  console.log("Seeding official recipes:", SEED_RECIPE_IDS.length);
  const payload = buildPayload();
  const { error } = await supabase
    .from("recipes")
    .upsert(payload, { onConflict: "id" })
    .select("id,is_official,owner_id,author_id,image");

  if (error) {
    console.error("Failed to seed official recipes:", error.message || error);
    process.exit(1);
  }

  console.log("Seed complete. Sample entry:", payload[0]);
};

run().catch((error) => {
  console.error("Unexpected error while seeding official recipes:", error.message || error);
  process.exit(1);
});
