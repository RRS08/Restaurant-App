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
// Mariscos — Coastal Mexican seafood. Demos for lead taquerias
// that also run a marisco side, or standalone seafood places in
// the RGV. Recipes pull through shrimp / fish / lime ingredients.
// ----------------------------------------------------------------
const MARISCOS: SeedConcept = {
  key: 'mariscos',
  labelEn: 'Mariscos',
  labelEs: 'Mariscos',
  categories: [
    { name: 'Cócteles',   sortOrder: 1 },
    { name: 'Ceviches',   sortOrder: 2 },
    { name: 'Pescados',   sortOrder: 3 },
    { name: 'Caldos',     sortOrder: 4 },
    { name: 'Bebidas',    sortOrder: 5 },
  ],
  inventory: [
    { key: 'camaron',         name: 'Camarón',              unit: 'lbs',   parInventory: 30 },
    { key: 'pescado_tilapia', name: 'Pescado Tilapia',      unit: 'lbs',   parInventory: 25 },
    { key: 'pulpo',           name: 'Pulpo',                unit: 'lbs',   parInventory: 8 },
    { key: 'limon_m',         name: 'Limones',              unit: 'units', parInventory: 120 },
    { key: 'cebolla_morada',  name: 'Cebolla Morada',       unit: 'lbs',   parInventory: 18 },
    { key: 'pepino',          name: 'Pepino',               unit: 'units', parInventory: 40 },
    { key: 'aguacate_m',      name: 'Aguacate',             unit: 'units', parInventory: 60 },
    { key: 'tomate_m',        name: 'Tomate',               unit: 'lbs',   parInventory: 20 },
    { key: 'cilantro_m',      name: 'Cilantro',             unit: 'bunches', parInventory: 25 },
    { key: 'tostadas',        name: 'Tostadas',             unit: 'units', parInventory: 200 },
    { key: 'salsa_picante',   name: 'Salsa Picante',        unit: 'units', parInventory: 18 },
    { key: 'jugo_naranja',    name: 'Jugo de Naranja',      unit: 'gallons', parInventory: 6 },
  ],
  menuItems: [
    { name: 'Cóctel de Camarón', price: 12.50, categoryName: 'Cócteles', recipe: [{ inventoryKey: 'camaron', quantity: 0.4 }, { inventoryKey: 'limon_m', quantity: 1 }, { inventoryKey: 'jugo_naranja', quantity: 0.05 }] },
    { name: 'Vuelve a la Vida',  price: 16.00, categoryName: 'Cócteles', recipe: [{ inventoryKey: 'camaron', quantity: 0.3 }, { inventoryKey: 'pulpo', quantity: 0.2 }, { inventoryKey: 'limon_m', quantity: 1 }] },
    { name: 'Ceviche de Pescado', price: 10.50, categoryName: 'Ceviches', recipe: [{ inventoryKey: 'pescado_tilapia', quantity: 0.35 }, { inventoryKey: 'limon_m', quantity: 2 }, { inventoryKey: 'cebolla_morada', quantity: 0.08 }] },
    { name: 'Aguachile Verde',   price: 13.50, categoryName: 'Ceviches', recipe: [{ inventoryKey: 'camaron', quantity: 0.4 }, { inventoryKey: 'limon_m', quantity: 3 }, { inventoryKey: 'cilantro_m', quantity: 0.2 }] },
    { name: 'Tostada de Atún',   price: 9.00,  categoryName: 'Ceviches', recipe: [{ inventoryKey: 'tostadas', quantity: 1 }, { inventoryKey: 'aguacate_m', quantity: 0.5 }] },
    { name: 'Pescado a la Plancha', price: 15.00, categoryName: 'Pescados', recipe: [{ inventoryKey: 'pescado_tilapia', quantity: 0.55 }, { inventoryKey: 'limon_m', quantity: 1 }] },
    { name: 'Camarones al Mojo de Ajo', price: 16.00, categoryName: 'Pescados', recipe: [{ inventoryKey: 'camaron', quantity: 0.5 }] },
    { name: 'Filete Empanizado', price: 14.00, categoryName: 'Pescados', recipe: [{ inventoryKey: 'pescado_tilapia', quantity: 0.5 }] },
    { name: 'Caldo de Camarón',  price: 12.00, categoryName: 'Caldos',   recipe: [{ inventoryKey: 'camaron', quantity: 0.35 }, { inventoryKey: 'tomate_m', quantity: 0.15 }] },
    { name: 'Sopa de Mariscos',  price: 14.50, categoryName: 'Caldos',   recipe: [{ inventoryKey: 'camaron', quantity: 0.2 }, { inventoryKey: 'pulpo', quantity: 0.15 }, { inventoryKey: 'pescado_tilapia', quantity: 0.15 }] },
    { name: 'Limonada',          price: 3.50,  categoryName: 'Bebidas',  recipe: [{ inventoryKey: 'limon_m', quantity: 3 }] },
    { name: 'Michelada',         price: 7.00,  categoryName: 'Bebidas',  recipe: [{ inventoryKey: 'limon_m', quantity: 1 }, { inventoryKey: 'salsa_picante', quantity: 0.05 }] },
    { name: 'Coca Cola',         price: 2.50,  categoryName: 'Bebidas' },
  ],
}

// ----------------------------------------------------------------
// Bakery / Panadería — Mexican bakery (pan dulce + tortillas).
// ----------------------------------------------------------------
const BAKERY: SeedConcept = {
  key: 'bakery',
  labelEn: 'Bakery',
  labelEs: 'Panadería',
  categories: [
    { name: 'Pan Dulce',     sortOrder: 1 },
    { name: 'Pan Salado',    sortOrder: 2 },
    { name: 'Tortillas',     sortOrder: 3 },
    { name: 'Bebidas',       sortOrder: 4 },
  ],
  inventory: [
    { key: 'harina_b',       name: 'Harina',                unit: 'lbs',   parInventory: 100 },
    { key: 'azucar_b',       name: 'Azúcar',                unit: 'lbs',   parInventory: 80 },
    { key: 'levadura_b',     name: 'Levadura',              unit: 'lbs',   parInventory: 8 },
    { key: 'mantequilla_b',  name: 'Mantequilla',           unit: 'lbs',   parInventory: 25 },
    { key: 'huevos_b',       name: 'Huevos',                unit: 'dozen', parInventory: 40 },
    { key: 'leche_b',        name: 'Leche',                 unit: 'gallons', parInventory: 10 },
    { key: 'canela_b',       name: 'Canela',                unit: 'lbs',   parInventory: 4 },
    { key: 'cocoa_b',        name: 'Cocoa',                 unit: 'lbs',   parInventory: 6 },
    { key: 'masa_maiz_b',    name: 'Masa de Maíz',          unit: 'lbs',   parInventory: 60 },
    { key: 'cafe_b',         name: 'Café Molido',           unit: 'lbs',   parInventory: 15 },
    { key: 'atole_mix_b',    name: 'Atole Mix',             unit: 'units', parInventory: 25 },
  ],
  menuItems: [
    { name: 'Concha',              price: 1.50, categoryName: 'Pan Dulce', recipe: [{ inventoryKey: 'harina_b', quantity: 0.15 }, { inventoryKey: 'azucar_b', quantity: 0.08 }] },
    { name: 'Cuerno',              price: 1.25, categoryName: 'Pan Dulce', recipe: [{ inventoryKey: 'harina_b', quantity: 0.1 }, { inventoryKey: 'mantequilla_b', quantity: 0.05 }] },
    { name: 'Empanada de Calabaza', price: 1.75, categoryName: 'Pan Dulce', recipe: [{ inventoryKey: 'harina_b', quantity: 0.12 }] },
    { name: 'Mantecada',           price: 1.25, categoryName: 'Pan Dulce', recipe: [{ inventoryKey: 'harina_b', quantity: 0.1 }, { inventoryKey: 'huevos_b', quantity: 0.04 }] },
    { name: 'Polvorón',            price: 1.00, categoryName: 'Pan Dulce', recipe: [{ inventoryKey: 'harina_b', quantity: 0.08 }, { inventoryKey: 'mantequilla_b', quantity: 0.04 }] },
    { name: 'Cubilete',            price: 2.00, categoryName: 'Pan Dulce', recipe: [{ inventoryKey: 'harina_b', quantity: 0.18 }, { inventoryKey: 'huevos_b', quantity: 0.06 }] },
    { name: 'Bolillo',             price: 0.50, categoryName: 'Pan Salado', recipe: [{ inventoryKey: 'harina_b', quantity: 0.1 }] },
    { name: 'Telera',              price: 0.50, categoryName: 'Pan Salado', recipe: [{ inventoryKey: 'harina_b', quantity: 0.1 }] },
    { name: 'Tortillas Maíz (doc)',   price: 3.00, categoryName: 'Tortillas', recipe: [{ inventoryKey: 'masa_maiz_b', quantity: 1.0 }] },
    { name: 'Tortillas Harina (doc)', price: 3.50, categoryName: 'Tortillas', recipe: [{ inventoryKey: 'harina_b', quantity: 0.8 }, { inventoryKey: 'mantequilla_b', quantity: 0.1 }] },
    { name: 'Café',                price: 2.50, categoryName: 'Bebidas',   recipe: [{ inventoryKey: 'cafe_b', quantity: 0.05 }, { inventoryKey: 'leche_b', quantity: 0.02 }] },
    { name: 'Atole de Cajeta',     price: 3.00, categoryName: 'Bebidas',   recipe: [{ inventoryKey: 'atole_mix_b', quantity: 0.1 }, { inventoryKey: 'leche_b', quantity: 0.04 }] },
    { name: 'Champurrado',         price: 3.50, categoryName: 'Bebidas',   recipe: [{ inventoryKey: 'atole_mix_b', quantity: 0.1 }, { inventoryKey: 'cocoa_b', quantity: 0.04 }, { inventoryKey: 'leche_b', quantity: 0.04 }] },
  ],
}

// ----------------------------------------------------------------
// Cafe — coffee shop with light food. American/independent vibe.
// ----------------------------------------------------------------
const CAFE: SeedConcept = {
  key: 'cafe',
  labelEn: 'Cafe',
  labelEs: 'Café',
  categories: [
    { name: 'Coffee',    sortOrder: 1 },
    { name: 'Tea',       sortOrder: 2 },
    { name: 'Pastries',  sortOrder: 3 },
    { name: 'Food',      sortOrder: 4 },
  ],
  inventory: [
    { key: 'coffee_beans',  name: 'Coffee Beans',    unit: 'lbs',     parInventory: 25 },
    { key: 'milk_whole',    name: 'Whole Milk',      unit: 'gallons', parInventory: 12 },
    { key: 'milk_oat',      name: 'Oat Milk',        unit: 'gallons', parInventory: 6 },
    { key: 'sugar_c',       name: 'Sugar',           unit: 'lbs',     parInventory: 30 },
    { key: 'syrup_vanilla', name: 'Vanilla Syrup',   unit: 'units',   parInventory: 8 },
    { key: 'syrup_caramel', name: 'Caramel Syrup',   unit: 'units',   parInventory: 8 },
    { key: 'tea_chamomile', name: 'Chamomile Tea',   unit: 'units',   parInventory: 80 },
    { key: 'tea_green',     name: 'Green Tea',       unit: 'units',   parInventory: 80 },
    { key: 'croissants',    name: 'Croissants',      unit: 'units',   parInventory: 24 },
    { key: 'muffins',       name: 'Muffins',         unit: 'units',   parInventory: 30 },
    { key: 'avocados_c',    name: 'Avocados',        unit: 'units',   parInventory: 40 },
    { key: 'sourdough',     name: 'Sourdough',       unit: 'loaves',  parInventory: 10 },
    { key: 'eggs_c',        name: 'Eggs',            unit: 'dozen',   parInventory: 15 },
    { key: 'bacon_c',       name: 'Bacon',           unit: 'lbs',     parInventory: 12 },
  ],
  menuItems: [
    { name: 'Espresso',          price: 3.00, categoryName: 'Coffee', recipe: [{ inventoryKey: 'coffee_beans', quantity: 0.03 }] },
    { name: 'Americano',         price: 3.25, categoryName: 'Coffee', recipe: [{ inventoryKey: 'coffee_beans', quantity: 0.03 }] },
    { name: 'Latte',             price: 4.50, categoryName: 'Coffee', recipe: [{ inventoryKey: 'coffee_beans', quantity: 0.04 }, { inventoryKey: 'milk_whole', quantity: 0.04 }] },
    { name: 'Cappuccino',        price: 4.50, categoryName: 'Coffee', recipe: [{ inventoryKey: 'coffee_beans', quantity: 0.04 }, { inventoryKey: 'milk_whole', quantity: 0.03 }] },
    { name: 'Mocha',             price: 5.00, categoryName: 'Coffee', recipe: [{ inventoryKey: 'coffee_beans', quantity: 0.04 }, { inventoryKey: 'milk_whole', quantity: 0.04 }, { inventoryKey: 'syrup_caramel', quantity: 0.06 }] },
    { name: 'Iced Latte',        price: 5.00, categoryName: 'Coffee', recipe: [{ inventoryKey: 'coffee_beans', quantity: 0.05 }, { inventoryKey: 'milk_whole', quantity: 0.05 }] },
    { name: 'Cold Brew',         price: 4.00, categoryName: 'Coffee', recipe: [{ inventoryKey: 'coffee_beans', quantity: 0.06 }] },
    { name: 'Chamomile Tea',     price: 3.50, categoryName: 'Tea',    recipe: [{ inventoryKey: 'tea_chamomile', quantity: 1 }] },
    { name: 'Green Tea',         price: 3.50, categoryName: 'Tea',    recipe: [{ inventoryKey: 'tea_green', quantity: 1 }] },
    { name: 'Croissant',         price: 3.50, categoryName: 'Pastries', recipe: [{ inventoryKey: 'croissants', quantity: 1 }] },
    { name: 'Blueberry Muffin',  price: 3.25, categoryName: 'Pastries', recipe: [{ inventoryKey: 'muffins', quantity: 1 }] },
    { name: 'Avocado Toast',     price: 9.50, categoryName: 'Food',   recipe: [{ inventoryKey: 'sourdough', quantity: 0.1 }, { inventoryKey: 'avocados_c', quantity: 0.5 }] },
    { name: 'Breakfast Sandwich', price: 8.50, categoryName: 'Food',  recipe: [{ inventoryKey: 'sourdough', quantity: 0.1 }, { inventoryKey: 'eggs_c', quantity: 0.16 }, { inventoryKey: 'bacon_c', quantity: 0.1 }] },
  ],
}

// ----------------------------------------------------------------
// BBQ — Texas-style smokehouse. Brisket, ribs, sides.
// ----------------------------------------------------------------
const BBQ: SeedConcept = {
  key: 'bbq',
  labelEn: 'BBQ',
  labelEs: 'BBQ',
  categories: [
    { name: 'Plates',     sortOrder: 1 },
    { name: 'Sandwiches', sortOrder: 2 },
    { name: 'Sides',      sortOrder: 3 },
    { name: 'Drinks',     sortOrder: 4 },
    { name: 'Desserts',   sortOrder: 5 },
  ],
  inventory: [
    { key: 'brisket',       name: 'Brisket',         unit: 'lbs',     parInventory: 40 },
    { key: 'pulled_pork',   name: 'Pulled Pork',     unit: 'lbs',     parInventory: 30 },
    { key: 'ribs',          name: 'Pork Ribs',       unit: 'racks',   parInventory: 18 },
    { key: 'sausage',       name: 'Sausage Links',   unit: 'units',   parInventory: 50 },
    { key: 'bbq_sauce',     name: 'BBQ Sauce',       unit: 'gallons', parInventory: 5 },
    { key: 'mac_cheese',    name: 'Mac & Cheese',    unit: 'lbs',     parInventory: 20 },
    { key: 'coleslaw',      name: 'Coleslaw',        unit: 'lbs',     parInventory: 18 },
    { key: 'cornbread_mix', name: 'Cornbread Mix',   unit: 'lbs',     parInventory: 15 },
    { key: 'pickles_bbq',   name: 'Pickles',         unit: 'gallons', parInventory: 4 },
    { key: 'buns_bbq',      name: 'Buns',            unit: 'units',   parInventory: 80 },
    { key: 'tea_bags_bbq',  name: 'Tea Bags',        unit: 'units',   parInventory: 100 },
    { key: 'lemons_bbq',    name: 'Lemons',          unit: 'units',   parInventory: 60 },
    { key: 'banana_pud_mix', name: 'Banana Pudding Mix', unit: 'lbs', parInventory: 8 },
  ],
  menuItems: [
    { name: 'Brisket Plate (½ lb)', price: 18.00, categoryName: 'Plates', recipe: [{ inventoryKey: 'brisket', quantity: 0.5 }, { inventoryKey: 'bbq_sauce', quantity: 0.02 }] },
    { name: 'Pulled Pork Plate',    price: 16.00, categoryName: 'Plates', recipe: [{ inventoryKey: 'pulled_pork', quantity: 0.5 }, { inventoryKey: 'bbq_sauce', quantity: 0.02 }] },
    { name: 'Ribs (½ rack)',        price: 20.00, categoryName: 'Plates', recipe: [{ inventoryKey: 'ribs', quantity: 0.5 }, { inventoryKey: 'bbq_sauce', quantity: 0.02 }] },
    { name: 'Sausage Link',         price: 9.00,  categoryName: 'Plates', recipe: [{ inventoryKey: 'sausage', quantity: 1 }] },
    { name: 'Combo Plate (3 meat)', price: 24.00, categoryName: 'Plates', recipe: [{ inventoryKey: 'brisket', quantity: 0.25 }, { inventoryKey: 'pulled_pork', quantity: 0.25 }, { inventoryKey: 'sausage', quantity: 1 }] },
    { name: 'Pulled Pork Sandwich', price: 10.50, categoryName: 'Sandwiches', recipe: [{ inventoryKey: 'pulled_pork', quantity: 0.3 }, { inventoryKey: 'buns_bbq', quantity: 1 }, { inventoryKey: 'coleslaw', quantity: 0.08 }] },
    { name: 'Brisket Sandwich',     price: 12.50, categoryName: 'Sandwiches', recipe: [{ inventoryKey: 'brisket', quantity: 0.3 }, { inventoryKey: 'buns_bbq', quantity: 1 }] },
    { name: 'Mac & Cheese',         price: 4.50,  categoryName: 'Sides', recipe: [{ inventoryKey: 'mac_cheese', quantity: 0.25 }] },
    { name: 'Coleslaw',             price: 3.50,  categoryName: 'Sides', recipe: [{ inventoryKey: 'coleslaw', quantity: 0.25 }] },
    { name: 'Cornbread',            price: 3.00,  categoryName: 'Sides', recipe: [{ inventoryKey: 'cornbread_mix', quantity: 0.15 }] },
    { name: 'Sweet Tea',            price: 3.00,  categoryName: 'Drinks', recipe: [{ inventoryKey: 'tea_bags_bbq', quantity: 1 }] },
    { name: 'Lemonade',             price: 3.50,  categoryName: 'Drinks', recipe: [{ inventoryKey: 'lemons_bbq', quantity: 2 }] },
    { name: 'Banana Pudding',       price: 5.50,  categoryName: 'Desserts', recipe: [{ inventoryKey: 'banana_pud_mix', quantity: 0.1 }] },
  ],
}

// ----------------------------------------------------------------
// Burgers — American burger joint.
// ----------------------------------------------------------------
const BURGERS: SeedConcept = {
  key: 'burgers',
  labelEn: 'Burgers',
  labelEs: 'Hamburguesas',
  categories: [
    { name: 'Burgers',    sortOrder: 1 },
    { name: 'Sandwiches', sortOrder: 2 },
    { name: 'Sides',      sortOrder: 3 },
    { name: 'Drinks',     sortOrder: 4 },
    { name: 'Desserts',   sortOrder: 5 },
  ],
  inventory: [
    { key: 'patties',       name: 'Beef Patties',     unit: 'lbs',     parInventory: 35 },
    { key: 'brioche_buns',  name: 'Brioche Buns',     unit: 'units',   parInventory: 80 },
    { key: 'cheese_slices', name: 'Cheese Slices',    unit: 'units',   parInventory: 200 },
    { key: 'bacon_bg',      name: 'Bacon',            unit: 'lbs',     parInventory: 15 },
    { key: 'lettuce',       name: 'Lettuce',          unit: 'heads',   parInventory: 25 },
    { key: 'tomatoes_bg',   name: 'Tomatoes',         unit: 'lbs',     parInventory: 20 },
    { key: 'onions_bg',     name: 'Onions',           unit: 'lbs',     parInventory: 25 },
    { key: 'pickles_bg',    name: 'Pickles',          unit: 'gallons', parInventory: 4 },
    { key: 'mushrooms_bg',  name: 'Mushrooms',        unit: 'lbs',     parInventory: 10 },
    { key: 'fries_frozen',  name: 'French Fries',     unit: 'lbs',     parInventory: 50 },
    { key: 'onion_rings_f', name: 'Onion Rings',      unit: 'lbs',     parInventory: 20 },
    { key: 'chicken_brst',  name: 'Chicken Breast',   unit: 'lbs',     parInventory: 20 },
    { key: 'mozz_sticks',   name: 'Mozzarella Sticks', unit: 'units',  parInventory: 80 },
    { key: 'ice_cream',     name: 'Ice Cream',        unit: 'gallons', parInventory: 6 },
  ],
  menuItems: [
    { name: 'Classic Cheeseburger', price: 9.50,  categoryName: 'Burgers', recipe: [{ inventoryKey: 'patties', quantity: 0.33 }, { inventoryKey: 'brioche_buns', quantity: 1 }, { inventoryKey: 'cheese_slices', quantity: 1 }] },
    { name: 'Bacon Cheeseburger',   price: 11.50, categoryName: 'Burgers', recipe: [{ inventoryKey: 'patties', quantity: 0.33 }, { inventoryKey: 'brioche_buns', quantity: 1 }, { inventoryKey: 'cheese_slices', quantity: 1 }, { inventoryKey: 'bacon_bg', quantity: 0.1 }] },
    { name: 'Double Cheeseburger',  price: 13.00, categoryName: 'Burgers', recipe: [{ inventoryKey: 'patties', quantity: 0.66 }, { inventoryKey: 'brioche_buns', quantity: 1 }, { inventoryKey: 'cheese_slices', quantity: 2 }] },
    { name: 'Smash Burger',         price: 10.00, categoryName: 'Burgers', recipe: [{ inventoryKey: 'patties', quantity: 0.33 }, { inventoryKey: 'brioche_buns', quantity: 1 }, { inventoryKey: 'cheese_slices', quantity: 1 }] },
    { name: 'Mushroom Swiss',       price: 11.00, categoryName: 'Burgers', recipe: [{ inventoryKey: 'patties', quantity: 0.33 }, { inventoryKey: 'brioche_buns', quantity: 1 }, { inventoryKey: 'mushrooms_bg', quantity: 0.1 }, { inventoryKey: 'cheese_slices', quantity: 1 }] },
    { name: 'Chicken Sandwich',     price: 9.50,  categoryName: 'Sandwiches', recipe: [{ inventoryKey: 'chicken_brst', quantity: 0.35 }, { inventoryKey: 'brioche_buns', quantity: 1 }, { inventoryKey: 'lettuce', quantity: 0.05 }] },
    { name: 'Pulled Pork Sandwich', price: 10.50, categoryName: 'Sandwiches', recipe: [{ inventoryKey: 'brioche_buns', quantity: 1 }] },
    { name: 'French Fries',         price: 4.00,  categoryName: 'Sides', recipe: [{ inventoryKey: 'fries_frozen', quantity: 0.3 }] },
    { name: 'Onion Rings',          price: 4.50,  categoryName: 'Sides', recipe: [{ inventoryKey: 'onion_rings_f', quantity: 0.25 }] },
    { name: 'Mozzarella Sticks',    price: 5.50,  categoryName: 'Sides', recipe: [{ inventoryKey: 'mozz_sticks', quantity: 5 }] },
    { name: 'Soft Drink',           price: 2.50,  categoryName: 'Drinks' },
    { name: 'Milkshake',            price: 5.50,  categoryName: 'Drinks', recipe: [{ inventoryKey: 'ice_cream', quantity: 0.05 }] },
    { name: 'Ice Cream (scoop)',    price: 3.50,  categoryName: 'Desserts', recipe: [{ inventoryKey: 'ice_cream', quantity: 0.03 }] },
  ],
}

// ----------------------------------------------------------------
// Tortilleria — tortilla shop + small antojitos.
// ----------------------------------------------------------------
const TORTILLERIA: SeedConcept = {
  key: 'tortilleria',
  labelEn: 'Tortilleria',
  labelEs: 'Tortillería',
  categories: [
    { name: 'Tortillas',  sortOrder: 1 },
    { name: 'Antojitos',  sortOrder: 2 },
    { name: 'Salsas',     sortOrder: 3 },
    { name: 'Bebidas',    sortOrder: 4 },
  ],
  inventory: [
    { key: 'masa_maiz_t',   name: 'Masa de Maíz Blanco',  unit: 'lbs',     parInventory: 150 },
    { key: 'masa_azul_t',   name: 'Masa de Maíz Azul',    unit: 'lbs',     parInventory: 40 },
    { key: 'harina_t',      name: 'Harina',               unit: 'lbs',     parInventory: 60 },
    { key: 'manteca_t',     name: 'Manteca',              unit: 'lbs',     parInventory: 20 },
    { key: 'tomatillos_t',  name: 'Tomatillos',           unit: 'lbs',     parInventory: 25 },
    { key: 'chile_guajillo', name: 'Chile Guajillo',      unit: 'lbs',     parInventory: 8 },
    { key: 'chile_pasilla', name: 'Chile Pasilla',        unit: 'lbs',     parInventory: 6 },
    { key: 'cebolla_t',     name: 'Cebolla',              unit: 'lbs',     parInventory: 20 },
    { key: 'aguacate_t',    name: 'Aguacate',             unit: 'units',   parInventory: 50 },
    { key: 'cilantro_t',    name: 'Cilantro',             unit: 'bunches', parInventory: 30 },
    { key: 'limon_t',       name: 'Limones',              unit: 'units',   parInventory: 100 },
    { key: 'tomate_t',      name: 'Tomate',               unit: 'lbs',     parInventory: 18 },
    { key: 'horchata_t',    name: 'Mezcla Horchata',      unit: 'units',   parInventory: 15 },
  ],
  menuItems: [
    { name: 'Tortillas Maíz (docena)',       price: 3.00, categoryName: 'Tortillas', recipe: [{ inventoryKey: 'masa_maiz_t', quantity: 1.0 }] },
    { name: 'Tortillas Harina (docena)',     price: 3.50, categoryName: 'Tortillas', recipe: [{ inventoryKey: 'harina_t', quantity: 0.8 }, { inventoryKey: 'manteca_t', quantity: 0.15 }] },
    { name: 'Tortillas Maíz Azul (docena)',  price: 4.50, categoryName: 'Tortillas', recipe: [{ inventoryKey: 'masa_azul_t', quantity: 1.0 }] },
    { name: 'Tortillas Grandes (cada una)',  price: 0.75, categoryName: 'Tortillas', recipe: [{ inventoryKey: 'masa_maiz_t', quantity: 0.15 }] },
    { name: 'Chilaquiles Verdes',            price: 9.00, categoryName: 'Antojitos', recipe: [{ inventoryKey: 'masa_maiz_t', quantity: 0.5 }, { inventoryKey: 'tomatillos_t', quantity: 0.25 }, { inventoryKey: 'cilantro_t', quantity: 0.1 }] },
    { name: 'Chilaquiles Rojos',             price: 9.00, categoryName: 'Antojitos', recipe: [{ inventoryKey: 'masa_maiz_t', quantity: 0.5 }, { inventoryKey: 'chile_guajillo', quantity: 0.05 }, { inventoryKey: 'tomate_t', quantity: 0.2 }] },
    { name: 'Sopa de Tortilla',              price: 8.50, categoryName: 'Antojitos', recipe: [{ inventoryKey: 'masa_maiz_t', quantity: 0.3 }, { inventoryKey: 'tomate_t', quantity: 0.2 }, { inventoryKey: 'aguacate_t', quantity: 0.5 }] },
    { name: 'Salsa Verde (8oz)',             price: 4.00, categoryName: 'Salsas',    recipe: [{ inventoryKey: 'tomatillos_t', quantity: 0.4 }, { inventoryKey: 'cilantro_t', quantity: 0.1 }] },
    { name: 'Salsa Roja (8oz)',              price: 4.00, categoryName: 'Salsas',    recipe: [{ inventoryKey: 'chile_guajillo', quantity: 0.06 }, { inventoryKey: 'tomate_t', quantity: 0.3 }] },
    { name: 'Salsa Pasilla (8oz)',           price: 4.50, categoryName: 'Salsas',    recipe: [{ inventoryKey: 'chile_pasilla', quantity: 0.06 }, { inventoryKey: 'tomate_t', quantity: 0.25 }] },
    { name: 'Guacamole (8oz)',               price: 6.50, categoryName: 'Salsas',    recipe: [{ inventoryKey: 'aguacate_t', quantity: 2 }, { inventoryKey: 'limon_t', quantity: 1 }, { inventoryKey: 'cilantro_t', quantity: 0.1 }] },
    { name: 'Pico de Gallo (8oz)',           price: 5.00, categoryName: 'Salsas',    recipe: [{ inventoryKey: 'tomate_t', quantity: 0.4 }, { inventoryKey: 'cebolla_t', quantity: 0.1 }, { inventoryKey: 'cilantro_t', quantity: 0.08 }] },
    { name: 'Horchata',                      price: 3.50, categoryName: 'Bebidas',   recipe: [{ inventoryKey: 'horchata_t', quantity: 0.1 }] },
    { name: 'Agua de Limón',                 price: 3.00, categoryName: 'Bebidas',   recipe: [{ inventoryKey: 'limon_t', quantity: 3 }] },
  ],
}

// ----------------------------------------------------------------
// Concepts list. All seven concepts ship as installable now. The
// dev-tools card iterates this array to render the Install /
// Activate / Uninstall row per concept.
// ----------------------------------------------------------------
export const SEED_CONCEPTS: SeedConcept[] = [
  TAQUERIA, MARISCOS, BAKERY, CAFE, BBQ, BURGERS, TORTILLERIA,
]

// Empty now that every concept has data. Kept exported so the
// dev-tools page can still call it without a type error; the UI
// just renders nothing for an empty array.
export const PLANNED_CONCEPTS: Array<{ key: string; labelEn: string; labelEs: string }> = []

export function findConcept(key: string): SeedConcept | undefined {
  return SEED_CONCEPTS.find((c) => c.key === key)
}
