// ----------------------------------------------------------------
// Menu availability — projection + sellability
//
// This module is the foundation for inventory-aware menu behavior.
// It returns three independent axes for a menu item:
//
//   1. STRUCTURAL state          — `active` flag on the row.
//   2. PROJECTION state          — what inventory + recipe say the
//                                  item can produce right now.
//   3. EFFECTIVE sellability     — what POS should obey, considering
//                                  structural state + projection +
//                                  manual override.
//
// Why split them: the manual override must NOT erase system truth.
// Even when a manager forces an item enabled despite a stock-out, the
// projection state still reads "out" so the drawer can honestly say
// "system says out, override is force-enabled." The three axes let
// every surface speak the truth that's relevant to it without
// flattening the model.
//
// The placeholder threshold below (`LOW_PROJECTED_THRESHOLD = 5`) is
// deliberately simple. The future intelligence layer will replace it
// with something like
//
//     low_threshold = expected_consumption_during_lead_time + safety_buffer
//
// — where consumption comes from sales velocity and lead time comes
// from each inventory item's `replenishment_lead_days`. Until that
// layer exists, the constant gets the product to a useful state
// without baking forecasting into the UI.
// ----------------------------------------------------------------

// ================================================================
// Shared vocabulary
// ================================================================

/** Manager-controlled availability override stored per menu item. */
export type AvailabilityOverride = 'none' | 'force_enabled' | 'force_disabled'

/** What inventory + recipe say about producibility right now. */
export type ProjectionState =
  | 'healthy'                  // projected_count > LOW_PROJECTED_THRESHOLD
  | 'low'                      // 0 < projected_count <= LOW_PROJECTED_THRESHOLD
  | 'out'                      // projected_count === 0
  | 'unavailable_to_project'   // unmapped, or any linked stock missing/inventory not active

/** What POS should obey for this item. */
export type EffectiveSellability =
  | 'enabled'
  | 'inactive'                 // active=false at the menu level (structural)
  | 'auto_disabled'            // active mapped item, projection=out, override=none
  | 'manually_disabled'        // override=force_disabled
  | 'manually_enabled'         // override=force_enabled (system truth still preserved)

/**
 * Placeholder low-stock threshold. See module doc for the future
 * intelligence model that will eventually replace this constant.
 */
export const LOW_PROJECTED_THRESHOLD = 5

// ================================================================
// Inputs
// ================================================================

export interface RecipeLink {
  inventoryItemId: string
  quantityRequired: number
}

export interface AvailabilityInput {
  active: boolean
  recipe: RecipeLink[]
  override: AvailabilityOverride
  /** Inventory activation gate. When false, projection is skipped. */
  inventoryActive: boolean
  /** inventory_item_id → current stock-on-hand. Items missing from
   *  the map are treated as "stock unknown" (projection becomes
   *  `unavailable_to_project`). */
  stockByInventoryItemId: Map<string, number>
}

export interface AvailabilityResult {
  projectedCount: number | null
  projectionState: ProjectionState
  effectiveSellability: EffectiveSellability
  /** Which inventory_item_id is the constraining ingredient. Null
   *  when projection didn't resolve to a definite count. */
  bottleneckInventoryItemId: string | null
}

// ================================================================
// Pure projection from recipe + stock
// ================================================================

interface RawProjection {
  count: number
  state: ProjectionState
  bottleneckId: string | null
}

function projectFromRecipe(
  recipe: RecipeLink[],
  stockByInventoryItemId: Map<string, number>
): RawProjection {
  if (recipe.length === 0) {
    return { count: 0, state: 'unavailable_to_project', bottleneckId: null }
  }

  let minCount = Infinity
  let bottleneck: string | null = null

  for (const link of recipe) {
    if (!stockByInventoryItemId.has(link.inventoryItemId)) {
      // Stock unknown for at least one ingredient — refuse to project.
      // Auto-disabling on a guess would surprise the manager.
      return { count: 0, state: 'unavailable_to_project', bottleneckId: null }
    }
    const stock = stockByInventoryItemId.get(link.inventoryItemId)!
    const qty = link.quantityRequired
    if (qty <= 0) continue // defensive — shouldn't happen, but skip if it does
    const possible = Math.floor(stock / qty)
    if (possible < minCount) {
      minCount = possible
      bottleneck = link.inventoryItemId
    }
  }

  if (minCount === Infinity) {
    // Every recipe row had qty <= 0 — degenerate; treat as unmapped.
    return { count: 0, state: 'unavailable_to_project', bottleneckId: null }
  }

  const safe = Math.max(0, minCount)
  const state: ProjectionState =
    safe === 0 ? 'out'
      : safe <= LOW_PROJECTED_THRESHOLD ? 'low'
      : 'healthy'
  return { count: safe, state, bottleneckId: bottleneck }
}

// ================================================================
// Top-level computation
// ================================================================

/**
 * Compute the full availability picture for a single menu item.
 *
 * Resolution order (lower rules win against higher rules):
 *   1. Manual override `force_disabled` → manually_disabled.
 *   2. `active === false`               → inactive (always wins over
 *                                         force_enabled — menu-level
 *                                         deactivation cannot be
 *                                         overridden).
 *   3. Manual override `force_enabled`  → manually_enabled (projection
 *                                         is still computed and surfaced
 *                                         so the drawer can show
 *                                         "system says out, override
 *                                         is on").
 *   4. Mapped + projection 'out'        → auto_disabled.
 *   5. Otherwise                        → enabled.
 *
 * Projection itself is `unavailable_to_project` when:
 *   - inventory tracking has not been activated for the restaurant,
 *   - the item has no recipe components, or
 *   - any linked ingredient has no recorded stock.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const { active, recipe, override, inventoryActive, stockByInventoryItemId } = input

  // Projection is a pure READ from recipe + stock — no side effects.
  // Always run it when we have the data. The activation flag ONLY
  // gates auto_disabled (a sellability decision), not projection
  // itself. Withholding the calculated count until activation was
  // over-strict — merchants with real counts and recipes want to
  // see "can produce N" as soon as they've counted, without also
  // having to commit to depletion tracking.
  const raw: RawProjection = projectFromRecipe(recipe, stockByInventoryItemId)

  const projectedCount = raw.state === 'unavailable_to_project' ? null : raw.count
  const projectionState = raw.state
  const bottleneckInventoryItemId = raw.bottleneckId

  // --- Effective sellability ---
  // Force-disabled wins everywhere. It's the only override that the
  // structural-inactive rule does not supersede, because both deny
  // selling — the override label is more informative for the manager.
  if (override === 'force_disabled') {
    return { projectedCount, projectionState, effectiveSellability: 'manually_disabled', bottleneckInventoryItemId }
  }

  // Structurally inactive cannot be re-enabled by force_enabled.
  if (!active) {
    return { projectedCount, projectionState, effectiveSellability: 'inactive', bottleneckInventoryItemId }
  }

  // Force-enabled keeps the item sellable even when system says out.
  if (override === 'force_enabled') {
    return { projectedCount, projectionState, effectiveSellability: 'manually_enabled', bottleneckInventoryItemId }
  }

  // Auto-disable ONLY when projection is a definite 'out' on a mapped
  // item AND inventory tracking is activated. `unavailable_to_project`
  // never auto-disables — we don't punish honest unknowns. And when
  // inventory hasn't been activated yet, we show the projected count
  // for informational purposes but don't yank items off the POS from
  // stale counts alone; auto-disable is a real side effect that
  // deserves the explicit activation gesture.
  if (projectionState === 'out' && inventoryActive) {
    return { projectedCount, projectionState, effectiveSellability: 'auto_disabled', bottleneckInventoryItemId }
  }

  return { projectedCount, projectionState, effectiveSellability: 'enabled', bottleneckInventoryItemId }
}

// ================================================================
// Surface helpers
// ================================================================

/** Is the item sellable at POS right now? */
export function isPosSellable(s: EffectiveSellability): boolean {
  return s === 'enabled' || s === 'manually_enabled'
}

/** A short, restrained label for card chips. Returns null when the
 *  item is healthy and shouldn't surface anything extra. */
export function shortAvailabilityChip(
  result: AvailabilityResult
): { label: string; tone: 'red' | 'amber' | 'gray' } | null {
  switch (result.effectiveSellability) {
    case 'manually_disabled':
      return { label: 'Disabled', tone: 'gray' }
    case 'manually_enabled':
      // Surface the underlying truth even with the override on.
      if (result.projectionState === 'out') {
        return { label: 'Out · Override on', tone: 'amber' }
      }
      return null
    case 'auto_disabled':
      return { label: 'Out', tone: 'red' }
    case 'inactive':
      // Existing 'Inactive' chip is rendered separately on the card.
      return null
    case 'enabled':
      if (result.projectionState === 'low' && result.projectedCount !== null) {
        return { label: `Low · ${result.projectedCount} left`, tone: 'amber' }
      }
      return null
  }
}
