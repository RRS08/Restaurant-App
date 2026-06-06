// ----------------------------------------------------------------
// Display-name normalization utilities.
//
// Purpose: keep user-entered short identifiers (item names, category
// names, vendor names) consistently cased and whitespace-clean so
// the database stops accumulating ten flavors of "mushroom".
//
// Two helpers, two jobs:
//
//   normalizeDisplayName  → the value we SAVE and DISPLAY.
//                           Trims, collapses internal whitespace,
//                           lowercases, then capitalizes each
//                           space-separated word.
//
//   normalizeNameKey      → the value we COMPARE against. Same
//                           trim + collapse + lowercase, but no
//                           title-casing. Use this on both sides of
//                           a duplicate check so casing /
//                           whitespace differences resolve to the
//                           same key.
//
// Applied in this pass to:
//   • Inventory item names
//   • Menu item names
//   (Both create and any future edit flows for the same fields.)
//
// READY for future application — keep one helper, many callers —
// when the same pattern is needed for Vendors, Employees,
// Locations, Roles, Menu Categories, and Expense Categories.
//
// DO NOT apply to fields whose raw value is semantically meaningful:
//   • email addresses (case may matter to deliverability; treat the
//     local part as-is and lowercase only when comparing, never on
//     save)
//   • API keys, secrets, tokens, external IDs (verbatim or break
//     auth / referential integrity)
//   • transaction descriptions, merchant names from bank feeds,
//     and other provider-supplied strings (must mirror source)
//   • URLs, file paths (case-sensitive on many filesystems)
//   • notes, free-text descriptions, recipe instructions (would
//     mangle the manager's wording — "ESCALATE" becomes "Escalate")
//
// When in doubt: ask "is this field a short identifier the manager
// types to name a thing they own?" If yes, normalize. Otherwise
// preserve raw.
// ----------------------------------------------------------------

/**
 * Normalize a user-entered identifier for SAVE/DISPLAY.
 *
 *   "  mushroom  "         → "Mushroom"
 *   "MUSHROOM"             → "Mushroom"
 *   "MUSHroom"             → "Mushroom"
 *   "nacho   cheese sauce" → "Nacho Cheese Sauce"
 *   "oil and vinegar"      → "Oil And Vinegar"  (no stop-word list yet)
 *
 * Intentionally simple — no exception lists for "and", "of", "the".
 * Layer those on top later if/when grammar exceptions matter; do
 * not fork this helper.
 */
export function normalizeDisplayName(name: string): string {
  if (typeof name !== 'string') return ''
  const collapsed = name.trim().replace(/\s+/g, ' ')
  if (collapsed.length === 0) return ''
  return collapsed
    .split(' ')
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
}

/**
 * Normalize a user-entered identifier for COMPARISON ONLY.
 *
 * Lowercases, trims, and collapses internal whitespace. Use on both
 * sides of a duplicate check so casing and whitespace differences
 * resolve to the same key:
 *
 *   normalizeNameKey("Mushroom")    === normalizeNameKey("mushroom")
 *   normalizeNameKey("MUSHROOM")    === normalizeNameKey("MUSHroom")
 *   normalizeNameKey("  mushroom")  === normalizeNameKey("mushroom")
 *   normalizeNameKey("nacho cheese") !== normalizeNameKey("nacho cheeses")
 *
 * Note: words separated by a space stay distinct ("mush room" is
 * NOT the same key as "mushroom"). That's intentional — collapsing
 * across word boundaries would erase real differences.
 *
 * Safe to use broadly for duplicate prevention even on fields where
 * display normalization is not appropriate. For example, comparing
 * vendor names against an existing list can use this key without
 * also rewriting the stored value.
 */
export function normalizeNameKey(name: string): string {
  if (typeof name !== 'string') return ''
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}
