// ----------------------------------------------------------------
// Demo seed concepts
//
// Self-contained datasets keyed by concept. Each entry defines the
// menu categories, menu items, inventory items, and recipe links
// the installer needs to drop a complete, demo-ready restaurant
// into a dev account.
//
// Recipe links use stable inventory keys (slugs) so the installer
// can resolve them to the just-inserted inventory_items rows
// without depending on UUIDs from a previous run.
//
// Adding a new concept:
//   1. Append a record to SEED_CONCEPTS below
//   2. Keep all `inventoryKey` references inside `recipe` pointing
//      to keys that exist in the same concept's `inventory` array
//   3. The installer + dev-tools card will pick it up automatically
//
// Labels are bilingual (en + es) since the system runs in both.
// Dev demos in RGV will toggle to ES; demos elsewhere stay EN.
// ----------------------------------------------------------------

export interface SeedCategory {
  name: string
  sortOrder: number
}

export interface SeedMenuItem {
  name: string
  price: number
  categoryName: string  // resolves to a SeedCategory.name within the same concept
  // Recipe ingredients — each entry consumes N units of an inventory key
  // when the item is sold. Empty array = no recipe (the item still sells
  // but doesn't deplete inventory).
  recipe?: Array<{ inventoryKey: string; quantity: number }>
}

export interface SeedInventoryItem {
  key: string             // stable slug used for recipe links
  name: string
  unit: string            // 'units', 'lbs', 'kg', 'oz', 'dozen', etc.
  parInventory: number    // typical on-hand quantity
}

export interface SeedConcept {
  key: string             // canonical id, stored as concept_key in the DB
  labelEn: string
  labelEs: string
  categories: SeedCategory[]
  menuItems: SeedMenuItem[]
  inventory: SeedInventoryItem[]
}

// ----------------------------------------------------------------
// Taqueria — Tacos al Pastor / Asada / Pollo / Carnitas plus a few
// classics. Recipes pull through tortillas, proteins, and salsa
// ingredients so the demo shows live inventory depletion the moment
// a taco rings up.
// ----------------------------------------------------------------
const TAQUERIA: SeedConcept = {
  key: 'taqueria',
  labelEn: 'Taqueria',
  labelEs: 'Taquería',
  categories: [
    { name: 'Tacos', sortOrder: 1 },
    { name: 'Burritos', sortOrder: 2 },
    { name: 'Especialidades', sortOrder: 3 },
    { name: 'Bebidas', sortOrder: 4 },
    { name: 'Postres', sortOrder: 5 },
  ],
  inventory: [
    { key: 'tortillas_maiz',  name: 'Tortillas de Maíz', unit: 'dozen', parInventory: 50 },
    { key: 'tortillas_harina', name: 'Tortillas de Harina', unit: 'dozen', parInventory: 30 },
    { key: 'carne_pastor',     name: 'Carne al Pastor',     unit: 'lbs',   parInventory: 25 },
    { key: 'carne_asada',      name: 'Carne Asada',          unit: 'lbs',   parInventory: 30 },
    { key: 'pollo',            name: 'Pollo',                unit: 'lbs',   parInventory: 20 },
    { key: 'carnitas',         name: 'Carnitas',             unit: 'lbs',   parInventory: 15 },
    { key: 'queso_oaxaca',     name: 'Queso Oaxaca',         unit: 'lbs',   parInventory: 10 },
    { key: 'frijoles',         name: 'Frijoles Refritos',    unit: 'lbs',   parInventory: 15 },
    { key: 'arroz_mexicano',   name: 'Arroz Mexicano',       unit: 'lbs',   parInventory: 12 },
    { key: 'cebolla',          name: 'Cebolla',              unit: 'lbs',   parInventory: 20 },
    { key: 'cilantro',         name: 'Cilantro',             unit: 'bunches', parInventory: 30 },
    { key: 'limon',            name: 'Limones',              unit: 'units', parInventory: 100 },
    { key: 'horchata_mix',     name: 'Mezcla de Horchata',   unit: 'units', parInventory: 20 },
    { key: 'jamaica_flor',     name: 'Flor de Jamaica',      unit: 'lbs',   parInventory: 5 },
  ],
  menuItems: [
    { name: 'Tacos al Pastor',    price: 3.50, categoryName: 'Tacos', recipe: [{ inventoryKey: 'tortillas_maiz', quantity: 0.083 }, { inventoryKey: 'carne_pastor', quantity: 0.25 }, { inventoryKey: 'cebolla', quantity: 0.05 }, { inventoryKey: 'cilantro', quantity: 0.05 }] },
    { name: 'Tacos de Asada',     price: 3.75, categoryName: 'Tacos', recipe: [{ inventoryKey: 'tortillas_maiz', quantity: 0.083 }, { inventoryKey: 'carne_asada', quantity: 0.25 }, { inventoryKey: 'cebolla', quantity: 0.05 }, { inventoryKey: 'cilantro', quantity: 0.05 }] },
    { name: 'Tacos de Pollo',     price: 3.25, categoryName: 'Tacos', recipe: [{ inventoryKey: 'tortillas_maiz', quantity: 0.083 }, { inventoryKey: 'pollo', quantity: 0.25 }, { inventoryKey: 'cebolla', quantity: 0.05 }] },
    { name: 'Tacos de Carnitas',  price: 3.50, categoryName: 'Tacos', recipe: [{ inventoryKey: 'tortillas_maiz', quantity: 0.083 }, { inventoryKey: 'carnitas', quantity: 0.25 }, { inventoryKey: 'cebolla', quantity: 0.05 }] },
    { name: 'Quesabirria',        price: 4.75, categoryName: 'Especialidades', recipe: [{ inventoryKey: 'tortillas_maiz', quantity: 0.167 }, { inventoryKey: 'carne_asada', quantity: 0.3 }, { inventoryKey: 'queso_oaxaca', quantity: 0.15 }] },
    { name: 'Quesadilla',         price: 5.00, categoryName: 'Especialidades', recipe: [{ inventoryKey: 'tortillas_harina', quantity: 0.083 }, { inventoryKey: 'queso_oaxaca', quantity: 0.2 }] },
    { name: 'Burrito de Asada',   price: 8.50, categoryName: 'Burritos', recipe: [{ inventoryKey: 'tortillas_harina', quantity: 0.083 }, { inventoryKey: 'carne_asada', quantity: 0.4 }, { inventoryKey: 'frijoles', quantity: 0.2 }, { inventoryKey: 'arroz_mexicano', quantity: 0.2 }] },
    { name: 'Burrito de Pollo',   price: 7.50, categoryName: 'Burritos', recipe: [{ inventoryKey: 'tortillas_harina', quantity: 0.083 }, { inventoryKey: 'pollo', quantity: 0.4 }, { inventoryKey: 'frijoles', quantity: 0.2 }, { inventoryKey: 'arroz_mexicano', quantity: 0.2 }] },
    { name: 'Horchata',           price: 3.50, categoryName: 'Bebidas', recipe: [{ inventoryKey: 'horchata_mix', quantity: 0.125 }] },
    { name: 'Agua de Jamaica',    price: 3.00, categoryName: 'Bebidas', recipe: [{ inventoryKey: 'jamaica_flor', quantity: 0.04 }, { inventoryKey: 'limon', quantity: 0.5 }] },
    { name: 'Jarritos',           price: 2.75, categoryName: 'Bebidas' },
    { name: 'Flan',               price: 4.00, categoryName: 'Postres' },
    { name: 'Churros (3 pz)',     price: 3.50, categoryName: 'Postres' },
  ],
}

// ----------------------------------------------------------------
// Concepts list. Future concepts (mariscos, bakery, cafe, bbq,
// burgers, tortilleria) ship as stubs from the dev-tools card —
// the user can install them after we write their data, one per
// follow-up session. Keeping the entries here gives the UI
// something to render before the data lands.
// ----------------------------------------------------------------
export const SEED_CONCEPTS: SeedConcept[] = [TAQUERIA]

// Concepts that show in the dev-tools card but aren't yet seeded.
// "Install" is disabled with a "coming soon" pill until we add
// the data above.
export const PLANNED_CONCEPTS: Array<{ key: string; labelEn: string; labelEs: string }> = [
  { key: 'mariscos',    labelEn: 'Mariscos',    labelEs: 'Mariscos' },
  { key: 'bakery',      labelEn: 'Bakery',      labelEs: 'Panadería' },
  { key: 'cafe',        labelEn: 'Cafe',        labelEs: 'Café' },
  { key: 'bbq',         labelEn: 'BBQ',         labelEs: 'BBQ' },
  { key: 'burgers',     labelEn: 'Burgers',     labelEs: 'Hamburguesas' },
  { key: 'tortilleria', labelEn: 'Tortilleria', labelEs: 'Tortillería' },
]

export function findConcept(key: string): SeedConcept | undefined {
  return SEED_CONCEPTS.find((c) => c.key === key)
}
