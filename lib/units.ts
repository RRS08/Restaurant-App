// ----------------------------------------------------------------
// Units + conversion — bridge recipe quantities to inventory
// quantities when the two aren't in the same unit of measure.
//
// Two convertible families (fixed factors, no per-item overrides):
//   • mass   — g, kg, oz, lb
//   • volume — ml, l, gal, floz, cup, tbsp, tsp
//
// A third bucket ("opaque") holds count-y or item-shaped units
// like `units`, `each`, `dozen`, `case`, `bag`, `bunch`, `head`,
// `loaf`, `rack`. Opaque units only match themselves — a recipe
// in `oz` cannot deplete an inventory tracked in `case` because
// "a case" of tomatoes and "a case" of paper towels aren't the
// same thing. That kind of resolution needs a per-inventory-item
// pack size, which is deliberately out of scope for v1.
//
// The DB stores whatever free-text the manager or seed handed us
// (`inventory_items.unit_of_measure` has no CHECK constraint). We
// normalize aggressively on read via `normalizeUnit`, so
// `lbs` / `Pounds` / `LB` all resolve to the canonical `lb`.
//
// Safety rule enforced by every caller: if `convertQty` returns
// `null` (incompatible families, or an unrecognized unit on
// either side), the sale must still succeed. The caller skips the
// depletion for that component and logs it — never lets a unit
// mismatch abort an order.
// ----------------------------------------------------------------

export type UnitFamily = 'mass' | 'volume' | 'opaque'

/** Canonical unit codes. `each` is the neutral count opaque. */
export type CanonicalUnit =
  // mass
  | 'g' | 'kg' | 'oz' | 'lb'
  // volume
  | 'ml' | 'l' | 'gal' | 'floz' | 'cup' | 'tbsp' | 'tsp'
  // opaque (count / package-shaped)
  | 'each' | 'dozen' | 'case' | 'bag' | 'bunch' | 'head' | 'loaf' | 'rack'

/** Aliases → canonical code. Casing/whitespace normalized before
 *  lookup, so callers can hand us anything reasonable. */
const ALIASES: Record<string, CanonicalUnit> = {
  // mass
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  // volume
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  floz: 'floz', 'fl oz': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  // opaque
  each: 'each', ea: 'each', unit: 'each', units: 'each', ct: 'each', count: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each',
  dozen: 'dozen', dz: 'dozen',
  case: 'case', cases: 'case', cs: 'case',
  bag: 'bag', bags: 'bag',
  bunch: 'bunch', bunches: 'bunch',
  head: 'head', heads: 'head',
  loaf: 'loaf', loaves: 'loaf',
  rack: 'rack', racks: 'rack',
}

/** Canonical → family. Used only for compatibility checks. */
const FAMILY: Record<CanonicalUnit, UnitFamily> = {
  g: 'mass', kg: 'mass', oz: 'mass', lb: 'mass',
  ml: 'volume', l: 'volume', gal: 'volume', floz: 'volume', cup: 'volume', tbsp: 'volume', tsp: 'volume',
  each: 'opaque', dozen: 'opaque', case: 'opaque', bag: 'opaque', bunch: 'opaque', head: 'opaque', loaf: 'opaque', rack: 'opaque',
}

/** Canonical → factor to the family's base unit. Mass base = g,
 *  volume base = ml. Opaque units have no factor — they never
 *  cross-convert. */
const TO_BASE: Partial<Record<CanonicalUnit, number>> = {
  // mass → g
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
  // volume → ml (US customary — matches how US restaurants speak)
  ml: 1,
  l: 1000,
  gal: 3785.411784,
  floz: 29.5735295625,
  cup: 236.5882365,
  tbsp: 14.78676478125,
  tsp: 4.92892159375,
}

/** Human-friendly label for the picker. Kept short enough to fit
 *  a compact unit-select next to a small number input. */
const LABEL: Record<CanonicalUnit, string> = {
  g: 'g', kg: 'kg', oz: 'oz', lb: 'lb',
  ml: 'ml', l: 'L', gal: 'gal', floz: 'fl oz', cup: 'cup', tbsp: 'tbsp', tsp: 'tsp',
  each: 'each', dozen: 'dozen', case: 'case', bag: 'bag', bunch: 'bunch', head: 'head', loaf: 'loaf', rack: 'rack',
}

/** All canonical units, grouped for the UI picker. Order matches
 *  how a manager thinks (smallest → largest within a family). */
export const UNIT_GROUPS: { family: UnitFamily; label: string; units: CanonicalUnit[] }[] = [
  { family: 'mass',   label: 'Weight',  units: ['g', 'kg', 'oz', 'lb'] },
  { family: 'volume', label: 'Volume',  units: ['ml', 'l', 'floz', 'cup', 'tbsp', 'tsp', 'gal'] },
  { family: 'opaque', label: 'Count',   units: ['each', 'dozen', 'case', 'bag', 'bunch', 'head', 'loaf', 'rack'] },
]

/** All canonical units, flat — used by the actions layer to
 *  validate a submitted unit string before persisting. */
export const ALL_CANONICAL_UNITS: CanonicalUnit[] = UNIT_GROUPS.flatMap((g) => g.units)

/** Normalize any free-text unit string to a canonical code. Returns
 *  `null` when the string doesn't map to anything we know — callers
 *  treat `null` as opaque-unknown and refuse conversion. */
export function normalizeUnit(raw: string | null | undefined): CanonicalUnit | null {
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  if (!key) return null
  return ALIASES[key] ?? null
}

/** Family of a canonical unit. `null` in → `null` out. */
export function familyOf(unit: CanonicalUnit | null): UnitFamily | null {
  return unit ? FAMILY[unit] : null
}

/** Short display label for a canonical unit. */
export function labelFor(unit: CanonicalUnit): string {
  return LABEL[unit]
}

/** Convert `qty` from `fromUnit` → `toUnit`. Returns the converted
 *  quantity, or `null` when:
 *    • either unit doesn't normalize to something we know
 *    • the two units live in different families (mass ↔ volume,
 *      or any cross with opaque)
 *    • both are opaque but not the same canonical code
 *
 *  Depletion callers treat null as "skip this component, log,
 *  don't fail the sale."
 *
 *  Accepts either raw strings (matched via `normalizeUnit`) or
 *  already-canonical codes. */
export function convertQty(
  qty: number,
  fromUnit: string | CanonicalUnit | null | undefined,
  toUnit: string | CanonicalUnit | null | undefined,
): number | null {
  if (!Number.isFinite(qty)) return null
  const from = typeof fromUnit === 'string' ? (ALIASES[fromUnit.trim().toLowerCase()] ?? null) : (fromUnit ?? null)
  const to = typeof toUnit === 'string' ? (ALIASES[toUnit.trim().toLowerCase()] ?? null) : (toUnit ?? null)
  if (!from || !to) return null
  if (from === to) return qty
  const fFam = FAMILY[from]
  const tFam = FAMILY[to]
  if (fFam !== tFam) return null
  if (fFam === 'opaque') return null // different opaque codes never cross
  const fFactor = TO_BASE[from]
  const tFactor = TO_BASE[to]
  if (fFactor === undefined || tFactor === undefined) return null
  return (qty * fFactor) / tFactor
}

/** Compatibility check without doing the math — useful for the UI
 *  to grey out incompatible unit picks or show a warning. */
export function unitsAreCompatible(
  a: string | CanonicalUnit | null | undefined,
  b: string | CanonicalUnit | null | undefined,
): boolean {
  const na = typeof a === 'string' ? normalizeUnit(a) : (a ?? null)
  const nb = typeof b === 'string' ? normalizeUnit(b) : (b ?? null)
  if (!na || !nb) return false
  if (na === nb) return true
  const fa = FAMILY[na]
  const fb = FAMILY[nb]
  if (fa !== fb) return false
  return fa !== 'opaque'
}
