// ----------------------------------------------------------------
// System-wide Readiness Model
//
// Single derivation helper the rest of the app reads whenever it
// needs to make an "is this pillar actually active?" decision.
//
// Rules:
//   • Setup is not activation.
//   • Inventory never silently goes live — requires explicit activation.
//   • Analytics uses a setup gate + a live-data gate.
//   • Dev overrides (bypass / per-pillar) are applied at the very end.
//
// Only one small table (`restaurant_setup_state`) holds explicit
// activation decisions and dev overrides. Everything else is computed
// from the existing data tables at read-time.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

// ================================================================
// Types
// ================================================================

export type PillarState =
  | 'not_started'
  | 'setup_in_progress'
  | 'ready'
  | 'active'
  | 'active_with_limitations'

export const VALID_PILLAR_STATES: PillarState[] = [
  'not_started', 'setup_in_progress', 'ready', 'active', 'active_with_limitations',
]

export type OperatingMode = 'native_pos' | 'external_pos' | null

export const PILLAR_KEYS = [
  'sales', 'menu', 'mapping', 'inventory', 'staffing',
  'finance', 'bankSync', 'dashboard', 'analytics',
] as const
export type PillarKey = typeof PILLAR_KEYS[number]

export interface ReadinessSnapshot {
  restaurantId: string
  operatingMode: OperatingMode
  devBypassAll: boolean
  devPillarOverrides: Partial<Record<PillarKey, PillarState>>

  pillars: Record<PillarKey, PillarState>

  signals: {
    menu: { itemCount: number; categoryCount: number; importedCount: number; unmappedCount: number }
    inventory: { itemCount: number; activatedAt: string | null; baselineCount: number }
    sales: { completedOrderCount: number; firstOrderAt: string | null; daysWithSales: number }
    staffing: { employeeCount: number; shiftCount: number; ratedEmployeeCount: number }
    finance: { expenseCount: number; connectedBankCount: number; syncedBankCount: number }
    analytics: {
      daysSinceFirstOrder: number
      minDaysRequired: number
      minOrdersRequired: number
    }
  }
}

// ================================================================
// Thresholds
// ================================================================

const ANALYTICS_MIN_DAYS = 7
const ANALYTICS_MIN_ORDERS = 10

// ================================================================
// computeReadiness
// ================================================================

export async function computeReadiness(
  supabase: SupabaseClient,
  restaurantId: string
): Promise<ReadinessSnapshot> {
  const [
    { data: setup },
    { data: menuCats },
    { data: menuItems },
    { data: recipeComponents },
    { data: invItems },
    { data: invCounts },
    { data: firstOrders },
    completedOrderCountRes,
    { data: employees },
    { data: shifts },
    expenseCountRes,
    { data: bankAccounts },
  ] = await Promise.all([
    supabase.from('restaurant_setup_state')
      .select('operating_mode, inventory_activated_at, dev_bypass_all, dev_pillar_overrides')
      .eq('restaurant_id', restaurantId)
      .maybeSingle(),
    supabase.from('menu_categories').select('id').limit(1000),
    supabase.from('menu_items').select('id, source, active').eq('active', true),
    supabase.from('recipe_components').select('menu_item_id'),
    supabase.from('inventory_items').select('id').eq('active', true),
    supabase.from('inventory_counts').select('id').limit(1),
    supabase.from('orders')
      .select('created_at')
      .eq('status', 'completed')
      .order('created_at', { ascending: true })
      .limit(1),
    supabase.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed'),
    supabase.from('employees').select('id, hourly_rate').eq('active', true),
    supabase.from('shifts').select('id').limit(1),
    supabase.from('expenses').select('id', { count: 'exact', head: true }),
    supabase.from('connected_bank_accounts').select('id, last_synced_at').eq('active', true),
  ])

  // ---- Menu signals ----
  const menuItemsList = (menuItems ?? []) as Array<{ id: string; source: string }>
  const menuItemIds = new Set(menuItemsList.map((m) => m.id))
  const mappedMenuItemIds = new Set((recipeComponents ?? []).map((r) => r.menu_item_id).filter(Boolean))
  const unmappedCount = [...menuItemIds].filter((id) => !mappedMenuItemIds.has(id)).length
  const importedCount = menuItemsList.filter((m) => m.source === 'imported' || m.source === 'external').length

  const menuSignals = {
    itemCount: menuItemsList.length,
    categoryCount: (menuCats ?? []).length,
    importedCount,
    unmappedCount,
  }

  // ---- Sales signals ----
  const orderCount = Number(completedOrderCountRes?.count ?? 0)
  const firstOrderAt = firstOrders?.[0]?.created_at ?? null
  const daysSinceFirstOrder = firstOrderAt
    ? Math.floor((Date.now() - new Date(firstOrderAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  const salesSignals = {
    completedOrderCount: orderCount,
    firstOrderAt,
    daysWithSales: daysSinceFirstOrder + (firstOrderAt ? 1 : 0),
  }

  // ---- Inventory signals ----
  const invSignals = {
    itemCount: (invItems ?? []).length,
    activatedAt: setup?.inventory_activated_at ?? null,
    baselineCount: (invCounts ?? []).length,
  }

  // ---- Staffing signals ----
  const employeesList = (employees ?? []) as Array<{ id: string; hourly_rate: number | null }>
  const staffingSignals = {
    employeeCount: employeesList.length,
    shiftCount: (shifts ?? []).length,
    ratedEmployeeCount: employeesList.filter((e) => Number(e.hourly_rate ?? 0) > 0).length,
  }

  // ---- Finance signals ----
  // A bank row can be `active=true` but never actually synced. Prior
  // audit flagged this as a false-confidence leak: "connected" was
  // treated the same as "has data", and Finance happily flipped to
  // 'active' with zero bank transactions. We now track both counts
  // separately so downstream logic can distinguish
  //   connected, but ghost     → syncedBankCount === 0
  //   connected and flowing    → syncedBankCount > 0
  const expenseCount = Number(expenseCountRes?.count ?? 0)
  const bankAccountsList = (bankAccounts ?? []) as Array<{ id: string; last_synced_at: string | null }>
  const syncedBankCount = bankAccountsList.filter((b) => !!b.last_synced_at).length
  const financeSignals = {
    expenseCount,
    connectedBankCount: bankAccountsList.length,
    syncedBankCount,
  }

  const analyticsSignals = {
    daysSinceFirstOrder,
    minDaysRequired: ANALYTICS_MIN_DAYS,
    minOrdersRequired: ANALYTICS_MIN_ORDERS,
  }

  // ================================================================
  // Real pillar derivations
  // ================================================================

  const operatingMode = (setup?.operating_mode ?? null) as OperatingMode

  let sales: PillarState = 'not_started'
  if (operatingMode) sales = orderCount > 0 ? 'active' : 'setup_in_progress'

  let menu: PillarState = 'not_started'
  if (menuSignals.itemCount > 0) {
    if (menuSignals.categoryCount === 0) menu = 'setup_in_progress'
    else menu = orderCount > 0 ? 'active' : 'ready'
  }

  let mapping: PillarState = 'not_started'
  if (menuSignals.itemCount > 0) {
    const mappedCount = menuSignals.itemCount - unmappedCount
    if (mappedCount === 0) mapping = 'not_started'
    else if (unmappedCount === 0) mapping = 'ready'
    else mapping = 'setup_in_progress'
  }

  let inventory: PillarState = 'not_started'
  if (invSignals.itemCount > 0) {
    if (invSignals.activatedAt) {
      inventory = unmappedCount > 0 ? 'active_with_limitations' : 'active'
    } else if (mapping === 'ready' || mapping === 'setup_in_progress') {
      inventory = 'ready'
    } else {
      inventory = 'setup_in_progress'
    }
  }

  let staffing: PillarState = 'not_started'
  if (staffingSignals.employeeCount > 0) {
    if (staffingSignals.shiftCount === 0) staffing = 'setup_in_progress'
    else if (staffingSignals.ratedEmployeeCount === 0) staffing = 'ready'
    else staffing = 'active'
  }

  // Finance only reaches 'active' when there's at least one bank row
  // that has actually synced. A ghost connection (active=true, never
  // synced) leaves finance at 'active_with_limitations' so the UI
  // doesn't imply full bank context when the table is empty.
  let finance: PillarState = 'not_started'
  if (orderCount > 0 || financeSignals.expenseCount > 0) {
    finance = financeSignals.syncedBankCount > 0 ? 'active' : 'active_with_limitations'
  } else if (operatingMode) {
    finance = 'setup_in_progress'
  }

  // Same distinction at the bankSync pillar level: connected-but-
  // never-synced is a real, honest intermediate state.
  let bankSync: PillarState = 'not_started'
  if (financeSignals.syncedBankCount > 0) {
    bankSync = 'active'
  } else if (financeSignals.connectedBankCount > 0) {
    bankSync = 'active_with_limitations'
  }

  const corePartial =
    sales !== 'active' ||
    inventory === 'not_started' ||
    inventory === 'setup_in_progress' ||
    menu === 'not_started'
  const dashboard: PillarState = corePartial ? 'active_with_limitations' : 'active'

  let analytics: PillarState = 'not_started'
  if (sales === 'active') {
    const enoughDays = daysSinceFirstOrder >= ANALYTICS_MIN_DAYS
    const enoughOrders = orderCount >= ANALYTICS_MIN_ORDERS
    analytics = enoughDays && enoughOrders ? 'active' : 'setup_in_progress'
  }

  const realPillars: Record<PillarKey, PillarState> = {
    sales, menu, mapping, inventory, staffing, finance, bankSync, dashboard, analytics,
  }

  // ================================================================
  // Dev overrides applied LAST — global bypass wins, then per-pillar.
  // Normal users never touch these columns (enforced by lib/dev.ts).
  // ================================================================

  const devBypassAll = Boolean(setup?.dev_bypass_all)
  const devOverridesRaw = (setup?.dev_pillar_overrides ?? {}) as Record<string, unknown>
  const devPillarOverrides: Partial<Record<PillarKey, PillarState>> = {}
  for (const key of PILLAR_KEYS) {
    const val = devOverridesRaw[key]
    if (typeof val === 'string' && (VALID_PILLAR_STATES as string[]).includes(val)) {
      devPillarOverrides[key] = val as PillarState
    }
  }

  const finalPillars: Record<PillarKey, PillarState> = { ...realPillars }
  if (devBypassAll) {
    for (const k of PILLAR_KEYS) finalPillars[k] = 'active'
  }
  for (const [k, v] of Object.entries(devPillarOverrides) as [PillarKey, PillarState][]) {
    finalPillars[k] = v
  }

  return {
    restaurantId,
    operatingMode,
    devBypassAll,
    devPillarOverrides,
    pillars: finalPillars,
    signals: {
      menu: menuSignals,
      inventory: invSignals,
      sales: salesSignals,
      staffing: staffingSignals,
      finance: financeSignals,
      analytics: analyticsSignals,
    },
  }
}

// ================================================================
// Narrow helpers used by server actions
// ================================================================

/**
 * Is inventory live right now? Used by createOrder / voidOrder to
 * gate the sales → inventory bridge. Returns the activation
 * timestamp so callers can also time-compare.
 *
 * NOTE: this intentionally ignores dev_bypass_all — the bridge is a
 * destructive side-effect, and the dev bypass is meant for UI gating,
 * not for silently making stock disappear.
 */
export async function getInventoryActivation(
  supabase: SupabaseClient,
  restaurantId: string
): Promise<{ activatedAt: Date | null }> {
  const { data } = await supabase
    .from('restaurant_setup_state')
    .select('inventory_activated_at')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  const raw = data?.inventory_activated_at ?? null
  return { activatedAt: raw ? new Date(raw) : null }
}

// ================================================================
// Shared pillar vocabulary
//
// Every surface that talks about a pillar's state should read from
// this dictionary instead of rolling its own wording. Keeps the
// product's "how sure are we right now?" voice consistent across
// dashboard, settings, analytics, and finance without any shared
// UI component — just one agreed-upon text + confidence tier.
//
// `confidence` is the tier the UI should use when deciding whether
// to show full, partial, or locked presentation:
//
//   none     pillar not started or mid-setup → do not present as real
//   partial  pillar live but with caveats   → show but annotate
//   full     pillar active and trusted      → present normally
// ================================================================

export type PillarConfidence = 'none' | 'partial' | 'full'

export const PILLAR_STATE_LABEL: Record<PillarState, string> = {
  not_started: 'Not started',
  setup_in_progress: 'Setup in progress',
  ready: 'Ready',
  active: 'Active',
  active_with_limitations: 'Active with limitations',
}

export function pillarConfidence(state: PillarState): PillarConfidence {
  switch (state) {
    case 'not_started':
    case 'setup_in_progress':
      return 'none'
    case 'ready':
    case 'active_with_limitations':
      return 'partial'
    case 'active':
      return 'full'
  }
}

/**
 * Is inventory ACTUALLY depleting stock right now?
 *
 * Distinct from `snapshot.pillars.inventory === 'active'`, which can
 * be flipped on by `dev_bypass_all`. This helper mirrors what
 * `getInventoryActivation` would return but works off an already-
 * loaded snapshot so page-level consumers don't need a second DB
 * round-trip. Use this anywhere the UI needs to talk truthfully
 * about real writes (e.g. "inventory depletion is live" badges).
 */
export function isInventoryWriteLive(snapshot: ReadinessSnapshot): boolean {
  return snapshot.signals.inventory.activatedAt !== null
}

/**
 * Does finance have at least one synced bank account? Mirrors the
 * new readiness logic so pages can show "bank connected, waiting
 * for first sync" without re-querying. Purely a signal read — no
 * DB calls.
 */
export function hasSyncedBank(snapshot: ReadinessSnapshot): boolean {
  return snapshot.signals.finance.syncedBankCount > 0
}

/**
 * Bank is connected but has never produced transactions yet. This
 * is a real, honest intermediate state: not "not connected", but
 * not "flowing" either. UIs should label it differently from
 * "no bank connected".
 */
export function hasConnectedButUnsyncedBank(snapshot: ReadinessSnapshot): boolean {
  const f = snapshot.signals.finance
  return f.connectedBankCount > 0 && f.syncedBankCount === 0
}

export async function getOperatingMode(
  supabase: SupabaseClient,
  restaurantId: string
): Promise<OperatingMode> {
  const { data } = await supabase
    .from('restaurant_setup_state')
    .select('operating_mode')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  return (data?.operating_mode ?? null) as OperatingMode
}
