'use client'

// ----------------------------------------------------------------
// Dashboard Client — Today's Operations.
//
// The daily command center for the restaurant operating system.
// Three bands:
//
//   1. Daily Status Strip — four compact operating cards
//      (Sales Today / Staff Coverage / Inventory Risk / Money Pulse).
//      Each one answers a single question for today.
//
//   2. Main Operating Area — left: Today's Rhythm (compact sales +
//      shifts charts); right: Needs Attention (the page's dominant
//      operational surface — a unified attention queue that absorbs
//      what used to be readiness banner + inventory watchlist +
//      action-needed list).
//
//   3. Supporting Readiness / Recent Movement — three calm cards:
//      Opening Readiness (system-state checks, replaces the old
//      user-editable checklist), Next Up (next shift), Recent
//      Movement (latest sale / inventory move / expense).
//
// Boundaries enforced by copy and what's surfaced:
//   - never interprets patterns       → Analytics' job
//   - never explains money            → Finance's job
//   - never reviews the ledger        → Sales' job
//   - never schedules                 → Staffing's job
//   - never manages stock workflow    → Inventory's job
//
// Dashboard only reports operating state and routes attention.
// ----------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { PillarKey, PillarState } from '@/lib/readiness'
import { makeT, type Lang } from '@/lib/i18n'

type T = (en: string, es?: string) => string

interface Props {
  lang: Lang
  firstName: string | null
  /** Server-rendered freshness stamp, e.g. "1:14 PM". Truthful: this
   *  is the request time the server produced the view at. */
  renderedAt: string
  readiness: Record<PillarKey, PillarState> | null
  bankConnectedUnsynced?: boolean
  inventoryWriteLive?: boolean
  inventory: {
    outOfStockCount: number
    lowStockCount: number
    noCountCount: number
    totalItems: number
  }
  staffing: {
    employeeCount: number
    shiftsToday: number
    shiftsThisWeek: number
  }
  sales: {
    ordersToday: number
    salesToday: number
    ordersLast7Days: number
    totalLast7Days: number
  }
  finance: {
    expenseCount30d: number
    expenseTotal30d: number
  }
  /** Current Mon–Sun week, one entry per day. Same day-by-day axis
   *  the interactive ShiftStrip uses, so chart and strip stay in
   *  lockstep. `orders` and `date` power the selected-day summary. */
  salesByDay: { label: string; value: number; orders: number; date: string }[]
  shiftsByDay: { label: string; value: number; employees: number; date: string }[]
  /** Flat current-week shift list — used by the selected-day summary
   *  to surface the first scheduled shift on the chosen day without
   *  a second round-trip. */
  weekShiftDetails: {
    id: string
    employeeName: string
    role: string
    startTime: string
    endTime: string
  }[]
  watchlist: {
    name: string
    status: 'Out' | 'Low' | 'No count'
    quantity: number | null
    threshold: number
    unit: string
  }[]
  /** Most recent inventory count timestamp — powers the
   *  "Last counted N ago" caption on the Inventory card. */
  latestInventoryCountAt?: string | null
  upcomingShifts: {
    id: string
    employeeName: string
    role: string
    startTime: string
    endTime: string
  }[]
  /** Bands (md+) Sales-today card renders the top 5 completed
   *  orders inline. Older layouts only need `latestSale` (the single
   *  most-recent), so this stays optional. */
  recentSales?: {
    id: string
    amount: number
    createdAt: string
    paymentType: 'card' | 'cash' | 'other'
    itemCount: number
  }[]
  /** Bands Needs-doing signals not already covered by topCards. */
  attention?: {
    unpricedMenuItems: number
    uncategorizedMenuItems: number
  }
  latestSale: { amount: number; datetime: string } | null
  latestExpense: { amount: number; date: string } | null
  latestInventoryMovement: {
    itemName: string
    quantityChange: number
    datetime: string
  } | null
  /** Pre-computed metric values for the four top-card carousels.
   *  Each pillar carries four metrics; the carousel rotates through
   *  them client-side on a calm 6s interval, staggered between cards. */
  topCards: {
    sales: {
      salesToday: number
      ordersToday: number
      avgTicketToday: number
      bestSeller: { name: string; count: number } | null
      paymentMix: { card: number; cash: number; other: number; total: number } | null
    }
    staffing: {
      shiftsToday: number
      hoursToday: number
      activeStaff: number
      /** Hourly-rate × hours for today's shifts. null when no shift
       *  this week had a rated employee (Labor estimate unavailable). */
      laborEstimateToday: number | null
      /** FOH / BOH split of today's shifts. null when no shifts
       *  have a section.area assigned (no house coverage data). */
      houseCoverage: { foh: number; boh: number } | null
    }
    inventory: {
      outItems: number
      lowItems: number
      /** Recorded inventory cost — sum of is_inventory_related
       *  expense rows in the 30-day window. Bank-settled figure
       *  is not yet exposed, so this is explicitly "recorded". */
      recordedInventoryCost30d: number
      pendingRestocks: { drafts: number; ordered: number }
    }
    finance: {
      moneyReview: { attention: number; auto: number; scanned: number }
      depositsToConfirm: number
      /** Sum of non-inventory expense rows in the 30-day window.
       *  Labeled "estimated" on the carousel. */
      operatingEstimate30d: number
      bankSyncedAt: string | null
    }
  }
}

// ================================================================
// Domain types for view-model
// ================================================================

// Severity / PillarTag / AttentionItem / buildAttention were removed
// when "Needs Attention" was replaced with the Quick Actions card.
// Their work is now done by the per-pillar Status carousels (current
// state) + the inventory pressure footer on Operating Pressure.

// ReadinessCheck / buildReadinessChecks / ReadinessDot were removed
// with the Daily Readiness card. The Manager To-Do card replaces it
// with a manager-editable checklist (DEFAULT_TODO_ITEMS, below).

// Default checklist for the Manager To-Do card. Seeds first-load
// state when localStorage is empty. The manager can edit, add,
// remove via the Manage drawer; their changes persist.
//
// Factory function (vs. constant) so the labels respect the current
// language at first-render time. After the items are saved to
// localStorage, they're frozen in whichever language was active —
// honest, since the manager can edit them freely.
function defaultTodoItems(t: T): { id: string; label: string; hint?: string }[] {
  return [
    { id: 'pos-ready',      label: t('Confirm POS is ready', 'Confirmar que el POS está listo'),                        hint: t('Hardware, network, signed in.', 'Hardware, red e inicio de sesión.') },
    { id: 'stock-check',    label: t('Check low-stock and out items', 'Revisar artículos bajos y agotados'),            hint: t('Review the Inventory card alerts.', 'Revisa las alertas de la tarjeta de Inventario.') },
    { id: 'staffing-today', label: t("Confirm today's staffing", 'Confirmar el personal de hoy'),                       hint: t('All blocks covered or gaps acknowledged.', 'Todos los bloques cubiertos o huecos identificados.') },
    { id: 'sales-check',    label: t('Review recent sales activity', 'Revisar actividad reciente de ventas'),           hint: t('Look at last 7 days vs today.', 'Compara los últimos 7 días con hoy.') },
    { id: 'money-review',   label: t('Check money review / deposits', 'Revisar dinero / depósitos'),                    hint: t('Confirm deposits and resolve exceptions.', 'Confirma depósitos y resuelve excepciones.') },
  ]
}

// ================================================================
// Formatting helpers
// ================================================================

const MONEY = (n: number, withCents = false): string =>
  `$${n.toLocaleString('en-US', {
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  })}`

function fmtRelative(iso: string, t: T, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return t('just now', 'justo ahora')
  if (diffMin < 60) return `${diffMin}${t('m ago', 'm atrás')}`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}${t('h ago', 'h atrás')}`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay}${t('d ago', 'd atrás')}`
  const diffWk = Math.round(diffDay / 7)
  return `${diffWk}${t('w ago', 'sem atrás')}`
}

function fmtDateOnly(iso: string, locale: string = 'en-US'): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

// ================================================================
// Bands (tablet md+) design tokens. Prefixed B_ so they can't
// collide with the existing Tailwind classes when phone renders.
// ================================================================
const B_INK = '#18181B'
const B_LINE = '#E7E6E2'
const B_LINE_SOFT = '#F0EFEB'
const B_SURFACE = '#FAFAF9'
const B_PANEL = '#FCFCFB'
const B_FILL = '#F4F4F5'
const B_MUTED = '#6B6B70'
const B_FAINT = '#A1A1A6'
const B_GHOST = '#D6D5D1'
const B_MONO = "'Geist Mono', ui-monospace, monospace"
const B_PAIR = {
  danger:  ['#FEF2F2', '#B91C1C'] as const,
  warning: ['#FFFBEB', '#B45309'] as const,
  success: ['#ECFDF5', '#047857'] as const,
  neutral: ['#F5F5F4', '#78716C'] as const,
}

// Short time-of-day for the Sales-today rows ("8:43p"). Matches
// the spec's row meta shape.
function fmtBandsTimeShort(iso: string): string {
  const d = new Date(iso)
  let h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const suffix = h >= 12 ? 'p' : 'a'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${m}${suffix}`
}

// ================================================================
// Main client
// ================================================================

export default function DashboardClient(props: Props) {
  const {
    lang,
    firstName,
    renderedAt,
    inventory,
    staffing,
    sales,
    finance,
    salesByDay,
    shiftsByDay,
    weekShiftDetails,
    upcomingShifts,
    latestSale,
    latestExpense,
    latestInventoryMovement,
    readiness,
    bankConnectedUnsynced,
    inventoryWriteLive,
    topCards,
    recentSales,
    watchlist,
    attention,
    latestInventoryCountAt,
  } = props
  const t = makeT(lang)

  // Bands (md+) tablet layout. Below md renders the existing
  // Tailwind dashboard unchanged. At md+ the return branches into
  // a full-viewport 4-card grid matching the Claude Design spec.
  const [isBands, setIsBands] = useState(false)
  const [isWide, setIsWide] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mqBands = window.matchMedia('(min-width: 768px)')
    const mqWide = window.matchMedia('(min-width: 1280px)')
    const update = () => { setIsBands(mqBands.matches); setIsWide(mqWide.matches) }
    update()
    mqBands.addEventListener('change', update)
    mqWide.addEventListener('change', update)
    return () => {
      mqBands.removeEventListener('change', update)
      mqWide.removeEventListener('change', update)
    }
  }, [])

  // Today's Mon..Sun index (0=Mon, 6=Sun). Used by Operating
  // Pressure to anchor today's column with a stronger fill.
  const todayIdx = useMemo(() => {
    const jsDay = new Date().getDay() // 0=Sun..6=Sat
    return jsDay === 0 ? 6 : jsDay - 1
  }, [])

  const stockAlerts = inventory.outOfStockCount + inventory.lowStockCount
  // Manager To-Do drawer — visibility lives on the root client so
  // both the card (which fires the open) and the drawer mount
  // (which lives below the support-row) share one source of truth.
  const [todoDrawerOpen, setTodoDrawerOpen] = useState(false)

  // Daily Status Strip — each card answers one question for today.
  const salesState: 'ready' | 'quiet' =
    sales.ordersToday > 0 ? 'ready' : 'quiet'

  const staffState: 'ready' | 'warn' =
    staffing.shiftsToday > 0 && staffing.employeeCount > 0 ? 'ready' : 'warn'
  const staffStatus =
    staffing.employeeCount === 0
      ? t('No team yet', 'Sin equipo aún')
      : staffing.shiftsToday === 0
        ? t('No shifts today', 'Sin turnos hoy')
        : t('Ready', 'Listo')

  const inventoryState: 'critical' | 'warn' | 'ready' =
    inventory.outOfStockCount > 0
      ? 'critical'
      : stockAlerts > 0 || inventory.noCountCount > 0
        ? 'warn'
        : 'ready'
  const inventoryStatus =
    inventory.outOfStockCount > 0
      ? t('Needs attention', 'Requiere atención')
      : stockAlerts > 0
        ? t('Watch items', 'Vigilar artículos')
        : !inventoryWriteLive
          ? t('Setup only', 'Solo configuración')
          : t('Stable', 'Estable')

  const financeState: 'ready' | 'limited' | 'pending' =
    readiness?.finance === 'active'
      ? 'ready'
      : readiness?.finance === 'active_with_limitations'
        ? 'limited'
        : 'pending'
  const financeStatus =
    financeState === 'ready'
      ? t('Bank synced', 'Banco sincronizado')
      : bankConnectedUnsynced
        ? t('Awaiting sync', 'Esperando sincronización')
        : financeState === 'limited'
          ? t('Internal only', 'Solo interno')
          : t('Needs setup', 'Requiere configuración')

  if (isBands) {
    // ============================================================
    // BANDS (md+) LAYOUT — full-viewport 4-card grid per Claude
    // Design spec. Reads existing server props; no page.tsx changes
    // beyond the new recentSales[] plumbing. Below md the else
    // branch renders the existing Tailwind dashboard unchanged.
    // ============================================================
    const now = new Date()
    const locale = lang === 'es' ? 'es-ES' : 'en-US'
    const bandsDateLabel = now.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })

    // Delta vs prior 7-day average — the fairest "how's today going".
    // avg7 = totalLast7Days / 7. Show a plain colored delta pct.
    const avg7 = sales.ordersLast7Days > 0 ? sales.totalLast7Days / 7 : 0
    const deltaPct = avg7 > 0 ? Math.round(((sales.salesToday - avg7) / avg7) * 100) : null

    // Needs doing — build from every real signal we have. Sorted
    // by severity (out-of-stock first, setup/setup-config last).
    // Each row names its destination; the icon set matches the
    // sidebar rail.
    type NoteArea = 'STOCK' | 'MONEY' | 'MENU' | 'STAFF'
    type Note = { area: NoteArea; title: string; detail: string; weight: number }
    const notes: Note[] = []

    // STOCK — most urgent first
    if (topCards.inventory.outItems > 0) {
      notes.push({
        area: 'STOCK', weight: 100,
        title: `${topCards.inventory.outItems} ${topCards.inventory.outItems === 1 ? t('item is out of stock', 'artículo agotado') : t('items are out of stock', 'artículos agotados')}`,
        detail: t('Restock before service continues.', 'Reabastece antes de continuar el servicio.'),
      })
    }
    if (topCards.inventory.lowItems > 0) {
      notes.push({
        area: 'STOCK', weight: 60,
        title: `${topCards.inventory.lowItems} ${topCards.inventory.lowItems === 1 ? t('item is running low', 'artículo con nivel bajo') : t('items are running low', 'artículos con nivel bajo')}`,
        detail: t('Below the restock point.', 'Debajo del punto de reorden.'),
      })
    }
    if (inventory.noCountCount > 0) {
      notes.push({
        area: 'STOCK', weight: 25,
        title: `${inventory.noCountCount} ${inventory.noCountCount === 1 ? t('item never counted', 'artículo sin conteo') : t('items never counted', 'artículos sin conteo')}`,
        detail: t('Do a first count so alerts start working.', 'Haz un primer conteo para activar las alertas.'),
      })
    }
    if (topCards.inventory.pendingRestocks.drafts > 0) {
      notes.push({
        area: 'STOCK', weight: 45,
        title: `${topCards.inventory.pendingRestocks.drafts} ${topCards.inventory.pendingRestocks.drafts === 1 ? t('draft restock waiting', 'reorden en borrador') : t('draft restocks waiting', 'reórdenes en borrador')}`,
        detail: t('Send them to a supplier.', 'Envíalos a un proveedor.'),
      })
    }

    // MONEY
    if (topCards.finance.moneyReview.attention > 0) {
      notes.push({
        area: 'MONEY', weight: 80,
        title: `${topCards.finance.moneyReview.attention} ${topCards.finance.moneyReview.attention === 1 ? t('bank item to confirm', 'ítem bancario por confirmar') : t('bank items to confirm', 'ítems bancarios por confirmar')}`,
        detail: t('Match deposits and card fees.', 'Confirma depósitos y cargos de tarjeta.'),
      })
    }
    if (topCards.finance.depositsToConfirm > 0) {
      notes.push({
        area: 'MONEY', weight: 55,
        title: `${topCards.finance.depositsToConfirm} ${topCards.finance.depositsToConfirm === 1 ? t('deposit to confirm', 'depósito por confirmar') : t('deposits to confirm', 'depósitos por confirmar')}`,
        detail: t('Waiting on your review in Finance.', 'Esperando tu revisión en Finanzas.'),
      })
    }
    if (bankConnectedUnsynced) {
      notes.push({
        area: 'MONEY', weight: 30,
        title: t('Bank hasn’t synced yet', 'El banco aún no sincroniza'),
        detail: t('Deposits will appear once it does.', 'Los depósitos aparecerán al sincronizar.'),
      })
    }

    // MENU
    if (attention && attention.unpricedMenuItems > 0) {
      notes.push({
        area: 'MENU', weight: 70,
        title: `${attention.unpricedMenuItems} ${attention.unpricedMenuItems === 1 ? t('menu item has no price', 'artículo del menú sin precio') : t('menu items have no price', 'artículos del menú sin precio')}`,
        detail: t('They can’t be sold until priced.', 'No se pueden vender hasta ponerles precio.'),
      })
    }
    if (attention && attention.uncategorizedMenuItems > 0) {
      notes.push({
        area: 'MENU', weight: 20,
        title: `${attention.uncategorizedMenuItems} ${attention.uncategorizedMenuItems === 1 ? t('item needs a category', 'artículo necesita categoría') : t('items need a category', 'artículos necesitan categoría')}`,
        detail: t('Assign them a section so they show up on the POS.', 'Asígnales una sección para que aparezcan en el POS.'),
      })
    }

    // STAFF
    if (staffing.shiftsToday === 0) {
      notes.push({
        area: 'STAFF', weight: 65,
        title: t('No shifts scheduled today', 'No hay turnos programados hoy'),
        detail: t('Add someone to the day so the floor is covered.', 'Agrega personal para cubrir el día.'),
      })
    }
    if (staffing.employeeCount === 0) {
      notes.push({
        area: 'STAFF', weight: 15,
        title: t('No employees yet', 'Aún no hay empleados'),
        detail: t('Add your team to start scheduling.', 'Agrega tu equipo para empezar a programar.'),
      })
    }

    notes.sort((a, b) => b.weight - a.weight)
    // Cap at 4 so the card stays a 4-row band matching the spec —
    // longer overflow tail collapses into the "N more" line the
    // Dashboard doesn't show yet.
    const needsDoingClipped = notes.slice(0, 4)

    // On the floor — upcomingShifts filtered to "started, not ended".
    const nowMs = now.getTime()
    const onFloor = (upcomingShifts ?? []).filter((s) => {
      const start = new Date(s.startTime).getTime()
      const end = new Date(s.endTime).getTime()
      return start <= nowMs && nowMs < end
    })
    // "Next up" — shifts starting today after now, chronological.
    // Feeds the On-the-floor footer's "Jonah 3:30p · Ines 4:00p"
    // pattern. Cap at 2 so long tail doesn't wrap the footer.
    const todayEndMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    const nextUp = (upcomingShifts ?? [])
      .filter((s) => {
        const start = new Date(s.startTime).getTime()
        return start > nowMs && start < todayEndMs
      })
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
      .slice(0, 2)
    // Latest end-time of any shift today (on floor or upcoming) —
    // read as the day's effective "closes at". If nothing scheduled,
    // stays null and the footer just omits it.
    const allTodayShifts = [...onFloor, ...nextUp]
    const closesAtMs = allTodayShifts.length > 0
      ? Math.max(...allTodayShifts.map((s) => new Date(s.endTime).getTime()))
      : null

    // Inventory watchlist — server ships up to 6, sorted Out→Low→NoCount.
    const watch = watchlist ?? []
    const inv = inventory
    const totalTracked = inv.totalItems
    const outSeg = totalTracked > 0 ? (inv.outOfStockCount / totalTracked) * 100 : 0
    const lowSeg = totalTracked > 0 ? (inv.lowStockCount / totalTracked) * 100 : 0

    return (
      <div
        data-page
        style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', fontFamily: "'Geist', system-ui, sans-serif", color: B_INK }}
      >
        {/* HEADER BAND */}
        <div style={{ flex: '0 0 auto', padding: '16px 24px 15px', borderBottom: `1px solid ${B_LINE}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em', whiteSpace: 'nowrap' }}>
                {bandsDateLabel}
              </h1>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: B_PAIR.success[0], color: B_PAIR.success[1], borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10B981' }} />
                {t('Open', 'Abierto')}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 9, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: B_MONO, fontSize: 34, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1 }}>
                {MONEY(sales.salesToday, true)}
              </span>
              <span style={{ fontFamily: B_MONO, fontSize: 11, color: B_FAINT }}>{t('TAKEN TODAY', 'HOY')}</span>
              {deltaPct !== null && (
                <span style={{ fontFamily: B_MONO, fontSize: 12, fontWeight: 600, color: deltaPct >= 0 ? B_PAIR.success[1] : B_PAIR.danger[1] }}>
                  {deltaPct >= 0 ? '↑' : '↓'} {Math.abs(deltaPct)}%
                </span>
              )}
              <BandsTrail value={String(sales.ordersToday)} label={sales.ordersToday === 1 ? t('sale', 'venta') : t('sales', 'ventas')} />
            </div>
          </div>
        </div>

        {/* CONTENT — two flex rows, no page scroll.
            Capped at 1500 on browser widths (xl+) so the 4 cards
            don't stretch across a wide monitor. Header above stays
            full-bleed; only the card region narrows. */}
        <div style={{ flex: 1, minHeight: 0, padding: '14px 24px 22px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: isWide ? 1500 : undefined, width: isWide ? '100%' : undefined, margin: isWide ? '0 auto' : undefined, alignSelf: isWide ? 'center' : undefined }}>

          {/* ROW 1 — Sales today (2fr) + Needs doing (1fr) */}
          <div style={{ flex: 1.12, minHeight: 0, display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>

            {/* SALES TODAY — orders list + side panel with payment
                mix, best seller, and average ticket. */}
            <BandsCard title={t('Sales today', 'Ventas de hoy')}>
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
                  {!recentSales || recentSales.length === 0 ? (
                    <div style={{ padding: '20px 16px', fontSize: 12, color: B_MUTED }}>
                      {t('No sales yet today.', 'Aún no hay ventas hoy.')}
                    </div>
                  ) : (
                    recentSales.map((s, i) => {
                      const isCard = s.paymentType === 'card'
                      const isCash = s.paymentType === 'cash'
                      const pair = isCard
                        ? (['#EEF2FF', '#4F46E5'] as const)
                        : isCash
                          ? B_PAIR.success
                          : B_PAIR.neutral
                      return (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: i === recentSales.length - 1 ? undefined : `1px solid ${B_LINE_SOFT}` }}>
                          <BandsTile pair={pair}>{isCash ? <BandsCashGlyph /> : <BandsCardGlyph />}</BandsTile>
                          <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {isCard ? t('Card sale', 'Venta con tarjeta') : isCash ? t('Cash sale', 'Venta en efectivo') : t('Sale', 'Venta')}
                            </span>
                            <span style={{ display: 'block', fontFamily: B_MONO, fontSize: 11, color: B_FAINT, marginTop: 2 }}>
                              {fmtBandsTimeShort(s.createdAt)} · {s.itemCount} {s.itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
                            </span>
                          </span>
                          <span style={{ fontFamily: B_MONO, fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', flex: '0 0 auto' }}>{MONEY(s.amount, true)}</span>
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Side panel — how they paid + best seller + avg ticket */}
                <div style={{ width: 186, flex: '0 0 186px', borderLeft: `1px solid ${B_LINE}`, background: B_PANEL, padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {topCards.sales.paymentMix && topCards.sales.paymentMix.total > 0 && (
                    <div>
                      <div style={{ fontFamily: B_MONO, fontSize: 10, letterSpacing: '0.16em', color: B_FAINT }}>{t('HOW THEY PAID', 'CÓMO PAGARON')}</div>
                      <div style={{ display: 'flex', height: 7, borderRadius: 999, overflow: 'hidden', gap: 2, marginTop: 9 }}>
                        <span style={{ width: `${(topCards.sales.paymentMix.card / topCards.sales.paymentMix.total) * 100}%`, height: '100%', borderRadius: 999, background: '#6366F1' }} />
                        <span style={{ width: `${(topCards.sales.paymentMix.cash / topCards.sales.paymentMix.total) * 100}%`, height: '100%', borderRadius: 999, background: '#10B981' }} />
                      </div>
                      <BandsSplit color="#6366F1" label={t('Card', 'Tarjeta')} value={MONEY(topCards.sales.paymentMix.card, true)} top={9} />
                      <BandsSplit color="#10B981" label={t('Cash', 'Efectivo')} value={MONEY(topCards.sales.paymentMix.cash, true)} top={5} />
                    </div>
                  )}
                  {topCards.sales.bestSeller && (
                    <div style={{ paddingTop: 13, borderTop: `1px solid ${B_LINE_SOFT}` }}>
                      <div style={{ fontFamily: B_MONO, fontSize: 10, letterSpacing: '0.16em', color: B_FAINT }}>{t('BEST SELLER', 'MÁS VENDIDO')}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 6, lineHeight: 1.3 }}>{topCards.sales.bestSeller.name}</div>
                      <div style={{ fontFamily: B_MONO, fontSize: 11, color: B_FAINT, marginTop: 3 }}>
                        {topCards.sales.bestSeller.count} {topCards.sales.bestSeller.count === 1 ? t('sold', 'vendido') : t('sold', 'vendidos')}
                      </div>
                    </div>
                  )}
                  <div style={{ marginTop: 'auto', paddingTop: 13, borderTop: `1px solid ${B_LINE_SOFT}` }}>
                    <div style={{ fontFamily: B_MONO, fontSize: 10, letterSpacing: '0.16em', color: B_FAINT }}>{t('AVERAGE TICKET', 'TICKET PROMEDIO')}</div>
                    <div style={{ fontFamily: B_MONO, fontSize: 17, fontWeight: 600, letterSpacing: '-0.03em', marginTop: 5 }}>
                      {MONEY(topCards.sales.avgTicketToday, true)}
                    </div>
                  </div>
                </div>
              </div>
            </BandsCard>

            {/* NEEDS DOING */}
            <BandsCard
              title={t('Needs doing', 'Por hacer')}
              aside={<span style={{ fontFamily: B_MONO, fontSize: 11, color: B_FAINT }}>{needsDoingClipped.length} {t('open', 'abiertos')}</span>}
            >
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                {needsDoingClipped.length === 0 ? (
                  <div style={{ padding: '20px 16px', fontSize: 12, color: B_MUTED, textAlign: 'center' }}>
                    {t('Nothing waiting.', 'Nada pendiente.')}
                  </div>
                ) : (
                  needsDoingClipped.map((n, i) => (
                    <div key={n.title + i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', flex: 1, minHeight: 0, borderBottom: i === needsDoingClipped.length - 1 ? undefined : `1px solid ${B_LINE_SOFT}` }}>
                      <BandsTile pair={[B_FILL, B_INK]}>
                        <BandsAreaGlyph area={n.area} />
                      </BandsTile>
                      <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '-0.015em', lineHeight: 1.3 }}>{n.title}</span>
                        <span style={{ display: 'block', fontSize: 11, color: B_FAINT, marginTop: 3, lineHeight: 1.4 }}>{n.detail}</span>
                      </span>
                      <span style={{ fontSize: 12, color: B_GHOST, flex: '0 0 auto' }}>›</span>
                    </div>
                  ))
                )}
              </div>
            </BandsCard>
          </div>

          {/* ROW 2 — On the floor (1fr) + Inventory (2fr) */}
          <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14 }}>

            {/* ON THE FLOOR */}
            <BandsCard
              title={t('On the floor', 'En operación')}
              aside={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: onFloor.length > 0 ? B_PAIR.success[0] : B_PAIR.neutral[0], color: onFloor.length > 0 ? B_PAIR.success[1] : B_PAIR.neutral[1], borderRadius: 999, padding: '2px 9px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: onFloor.length > 0 ? '#10B981' : '#78716C' }} />
                  {onFloor.length > 0 ? t('Covered', 'Cubierto') : t('Nobody in', 'Nadie')}
                </span>
              }
              footer={(nextUp.length > 0 || closesAtMs) ? (
                <>
                  <span style={{ fontSize: 11, color: B_MUTED }}>
                    {nextUp.length > 0
                      ? nextUp.map((s) => `${s.employeeName.split(' ')[0]} ${fmtBandsTimeShort(s.startTime)}`).join(' · ')
                      : t('No one else scheduled today', 'Nadie más programado hoy')}
                  </span>
                  {closesAtMs && (
                    <span style={{ fontFamily: B_MONO, fontSize: 11, fontWeight: 600 }}>
                      {t('closes', 'cierra')} {fmtBandsTimeShort(new Date(closesAtMs).toISOString())}
                    </span>
                  )}
                </>
              ) : undefined}
            >
              <div style={{ flex: '0 0 auto', padding: '12px 15px 11px', borderBottom: `1px solid ${B_LINE_SOFT}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontFamily: B_MONO, fontSize: 26, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1 }}>{onFloor.length}</span>
                  <span style={{ fontSize: 12, color: B_MUTED }}>{t('working right now', 'trabajando ahora')}</span>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                {onFloor.length === 0 ? (
                  <div style={{ padding: '20px 15px', fontSize: 12, color: B_MUTED }}>
                    {t('No one is scheduled right now.', 'Nadie programado ahora.')}
                  </div>
                ) : (
                  onFloor.map((f, i) => {
                    const initials = f.employeeName.split(' ').map((w) => w[0] || '').join('').slice(0, 2) || '·'
                    const color = '#3F3F46'
                    return (
                      <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 15px', flex: 1, minHeight: 0, borderBottom: i === onFloor.length - 1 ? undefined : `1px solid ${B_LINE_SOFT}` }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 999, flex: '0 0 auto', background: `${color}1A`, color, fontFamily: B_MONO, fontSize: 10, fontWeight: 600 }}>
                          {initials.toUpperCase()}
                        </span>
                        <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{f.employeeName}</span>
                          <span style={{ display: 'block', fontSize: 11, marginTop: 1, color }}>{f.role}</span>
                        </span>
                        <span style={{ fontFamily: B_MONO, fontSize: 11, color: B_MUTED, flex: '0 0 auto' }}>
                          {t('until', 'hasta')} {fmtBandsTimeShort(f.endTime)}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            </BandsCard>

            {/* INVENTORY */}
            <BandsCard
              title={t('Inventory', 'Inventario')}
              aside={<span style={{ fontFamily: B_MONO, fontSize: 11, color: B_FAINT }}>{watch.length} {t('to restock', 'por reabastecer')}</span>}
            >
              <div style={{ flex: '0 0 auto', padding: '14px 16px 13px', borderBottom: `1px solid ${B_LINE_SOFT}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: B_MONO, fontSize: 30, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1 }}>{totalTracked}</span>
                  <span style={{ fontSize: 12, color: B_MUTED }}>{t('items tracked', 'artículos registrados')}</span>
                  {(inv.outOfStockCount + inv.lowStockCount) > 0 && (
                    <BandsTrail value={String(inv.outOfStockCount + inv.lowStockCount)} label={t('need restocking', 'requieren reabastecimiento')} tone={B_PAIR.warning[1]} />
                  )}
                </div>
                {totalTracked > 0 && (
                  <>
                    <div style={{ display: 'flex', height: 9, borderRadius: 999, overflow: 'hidden', gap: 2, marginTop: 13 }}>
                      {inv.outOfStockCount > 0 && (
                        <span style={{ width: `${outSeg}%`, minWidth: 10, height: '100%', borderRadius: 999, background: '#DC2626' }} />
                      )}
                      {inv.lowStockCount > 0 && (
                        <span style={{ width: `${lowSeg}%`, minWidth: 14, height: '100%', borderRadius: 999, background: '#D97706' }} />
                      )}
                      <span style={{ flex: 1, height: '100%', borderRadius: 999, background: B_GHOST }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 10, flexWrap: 'wrap' }}>
                      <BandsLegend color="#DC2626" value={String(inv.outOfStockCount)} label={t('out of stock', 'agotado')} ink={B_PAIR.danger[1]} />
                      <BandsLegend color="#D97706" value={String(inv.lowStockCount)} label={t('running low', 'nivel bajo')} ink={B_PAIR.warning[1]} />
                      <BandsLegend color={B_GHOST} value={String(inv.noCountCount)} label={t('never counted', 'sin conteo')} ink={B_PAIR.neutral[1]} />
                      {latestInventoryCountAt && (
                        <span style={{ fontSize: 11, color: B_FAINT, marginLeft: 'auto' }}>
                          {t('Last counted', 'Último conteo')} {fmtRelative(latestInventoryCountAt, t)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px 14px' }}>
                {watch.length === 0 ? (
                  <div style={{ padding: '12px 0', fontSize: 12, color: B_MUTED }}>
                    {t('Everything is above its restock point.', 'Todo está por encima del punto de reorden.')}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
                    {watch.slice(0, 6).map((it, i) => {
                      const isOut = it.status === 'Out'
                      const pair = isOut ? B_PAIR.danger : it.status === 'Low' ? B_PAIR.warning : B_PAIR.neutral
                      const last = i >= watch.slice(0, 6).length - 2
                      const unit = it.unit || ''
                      // Right-side value: literal "Out" when out of
                      // stock; otherwise the estimated quantity + unit.
                      // Never-counted rows show em-dash.
                      const value = isOut
                        ? t('Out', 'Agotado')
                        : it.status === 'Low' && it.quantity !== null
                          ? `${it.quantity.toFixed(2)}${unit ? ` ${unit}` : ''}`
                          : '—'
                      return (
                        <div key={it.name + i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: last ? undefined : `1px solid ${B_LINE_SOFT}` }}>
                          <BandsTile pair={pair} size={26}>
                            {isOut ? <BandsOutGlyph /> : <BandsLowGlyph />}
                          </BandsTile>
                          <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                            <span style={{ display: 'block', fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
                            <span style={{ display: 'block', fontFamily: B_MONO, fontSize: 10, color: B_FAINT, marginTop: 2 }}>
                              {t('restock at', 'reabastecer a')} {it.threshold.toFixed(2)}{unit ? ` ${unit}` : ''}
                            </span>
                          </span>
                          <span style={{ fontFamily: B_MONO, fontSize: 12, fontWeight: 600, flex: '0 0 auto', color: pair[1] }}>
                            {value}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </BandsCard>
          </div>
        </div>
      </div>
    )
  }

  return (
    // Constrained content width — same family standard as Staffing,
    // Analytics, Inventory, Finance, and POS. Preserves intentional
    // right-side whitespace on wide screens so Dashboard reads as a
    // focused operating workspace, not a wall-to-wall admin grid.
    <div className="max-w-[1400px]">
      {/* ============================================================ */}
      {/* HEADER — page identity is "Today's Operations", greeting is a  */}
      {/* small eyebrow so personalization stays but doesn't lead.       */}
      {/* The standalone notification bell was removed — the Needs       */}
      {/* Attention queue below is the single operational triage         */}
      {/* surface, so a separate bell would just compete with it.        */}
      {/* ============================================================ */}
      <div className="mb-5 pb-4 border-b border-gray-100 flex items-end justify-between gap-4 flex-wrap">
        <div>
          {firstName && (
            <p className="text-[11px] text-gray-500 mb-1">
              {t('Welcome back,', 'Bienvenido de vuelta,')} {firstName}
            </p>
          )}
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">
            {t("Today's Operations", 'Operaciones de hoy')}
          </h1>
          <p className="mt-1.5 text-sm text-gray-500">
            {t('A quick read on sales, stock, staffing, and finance.', 'Una lectura rápida de ventas, inventario, personal y finanzas.')}
          </p>
        </div>
        {/* Truthful render-time stamp. Not live — accurate as of the
            request that produced this view. */}
        <p className="text-[11px] text-gray-500 font-mono tabular-nums">
          {t('Updated', 'Actualizado')} {renderedAt}
        </p>
      </div>

      {/* ============================================================ */}
      {/* 1. DAILY STATUS STRIP                                          */}
      {/* Four compact operating cards. Each answers "is this OK today?" */}
      {/* with one number + a short status word. Color is restrained:    */}
      {/* small status dot + soft left-edge accent on non-normal states. */}
      {/* ============================================================ */}
      {/* Sub-copy is deliberately operational ("X completed orders
          today" / "No coverage scheduled today" / "Y items need
          review" / "Z expenses · last 30d"). The eye should land on
          the main number, then read the supporting line, then check
          the status pill — each layer answers "is today okay?" at
          a different fidelity. */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-5">
        <StatusCarousel
          href="/sales"
          label={t('Sales', 'Ventas')}
          status={topCards.sales.ordersToday === 0 ? t('No sales yet', 'Sin ventas aún') : t('Active', 'Activo')}
          tone={salesState === 'ready' ? 'normal' : 'neutral'}
          rotateOffsetMs={0}
          metrics={buildSalesMetrics(topCards.sales, t)}
        />
        <StatusCarousel
          href="/staffing"
          label={t('Staffing', 'Personal')}
          status={staffStatus}
          tone={staffState === 'ready' ? 'normal' : 'warn'}
          rotateOffsetMs={1500}
          metrics={buildStaffingMetrics(topCards.staffing, t)}
        />
        <StatusCarousel
          href="/inventory"
          label={t('Inventory', 'Inventario')}
          status={inventoryStatus}
          tone={
            inventoryState === 'critical'
              ? 'critical'
              : inventoryState === 'warn'
                ? 'warn'
                : 'normal'
          }
          rotateOffsetMs={3000}
          metrics={buildInventoryMetrics(topCards.inventory, t)}
        />
        <StatusCarousel
          href="/finance"
          label={t('Finance', 'Finanzas')}
          status={financeStatus}
          tone={
            financeState === 'ready'
              ? 'normal'
              : financeState === 'limited'
                ? 'neutral'
                : 'warn'
          }
          rotateOffsetMs={4500}
          metrics={buildFinanceMetrics(topCards.finance, t)}
        />
      </div>

      {/* ============================================================ */}
      {/* 2. MAIN OPERATING AREA                                         */}
      {/* Left: Operating Pressure — multi-pillar weekly read.           */}
      {/* Right: Quick Actions — common manager shortcuts.               */}
      {/* The left card answers "what should I notice?"; the right       */}
      {/* answers "what can I do right now?".                            */}
      {/* ============================================================ */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-5 mb-5">

        {/* LEFT — Operating Pressure (col-span-3). A weekly chart
            of derived pressure (sales × demand factor, capped to
            scale). Hover a column for full detail. The chart fills
            the card; no bottom interpretation block. */}
        <OperatingPressureCard
          salesByDay={salesByDay}
          shiftsByDay={shiftsByDay}
          todayIdx={todayIdx}
          outItems={inventory.outOfStockCount}
          lowItems={inventory.lowStockCount}
          t={t}
        />

        {/* RIGHT — Quick Actions (col-span-2). Action-oriented
            shortcuts to the most-used manager flows. Each row
            navigates to the relevant page (some with a query
            param that opens the relevant drawer on landing). */}
        <QuickActionsCard t={t} />

      </div>

      {/* ============================================================ */}
      {/* 3. SUPPORTING READINESS / RECENT MOVEMENT                      */}
      {/* Three calm support cards.                                      */}
      {/* ============================================================ */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-3">

        {/* Manager To-Do — replaces the system-driven Daily
            Readiness card. Items are managed in a drawer + persist
            in localStorage. Defaults seeded from `readinessChecks`
            so the first-load experience already has a meaningful
            checklist; the manager can edit, add, or remove from
            there. See ManagerTodoCard. */}
        <ManagerTodoCard
          defaultItems={defaultTodoItems(t)}
          onOpenManager={() => setTodoDrawerOpen(true)}
          t={t}
        />

        {/* Next Shift / Clock-In Check — replaces the static "Next
            up" card. Within the first hour after a shift's
            start_time, switches to a clock-in watch state listing
            scheduled staff for that shift. Outside that window,
            shows the next upcoming shift group (everyone starting
            at the same time, regardless of role/house). */}
        <NextShiftCard upcomingShifts={upcomingShifts} t={t} />

        {/* Recent movement — proof the system is alive */}
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              {t('Recent movement', 'Movimiento reciente')}
            </p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              {t('Latest activity across the system.', 'Última actividad en el sistema.')}
            </p>
          </div>
          <ul className="divide-y divide-gray-100">
            <MovementRow
              label={t('Latest sale', 'Última venta')}
              value={latestSale ? MONEY(latestSale.amount, true) : null}
              when={latestSale?.datetime ?? null}
              relative
              t={t}
            />
            <MovementRow
              label={t('Inventory move', 'Movimiento de inventario')}
              value={
                latestInventoryMovement
                  ? `${latestInventoryMovement.itemName} · ${latestInventoryMovement.quantityChange > 0 ? '+' : ''}${latestInventoryMovement.quantityChange}`
                  : null
              }
              when={latestInventoryMovement?.datetime ?? null}
              relative
              t={t}
            />
            <MovementRow
              label={t('Latest expense', 'Último gasto')}
              value={latestExpense ? MONEY(latestExpense.amount, true) : null}
              when={latestExpense?.date ?? null}
              relative={false}
              t={t}
            />
          </ul>
        </div>

      </div>

      {/* Manager To-Do edit drawer — sibling at the page root so
          it overlays cleanly. Manual expense quick action moved to
          the middle Quick Actions card. */}
      <ManagerTodoDrawer
        open={todoDrawerOpen}
        onClose={() => setTodoDrawerOpen(false)}
        t={t}
      />
    </div>
  )
}

// ================================================================
// DailyStatusCard — top-row operating tile. Unified white chrome,
// pillar identity through the label, state via small status pill +
// soft left-edge accent. Never tints the whole card.
// ================================================================
function DailyStatusCard({
  href,
  label,
  value,
  sub,
  status,
  tone,
}: {
  href: string
  label: string
  value: string
  sub: string
  status: string
  tone: 'normal' | 'neutral' | 'warn' | 'critical'
}) {
  const accent =
    tone === 'critical'
      ? 'border-l-2 border-l-red-300'
      : tone === 'warn'
        ? 'border-l-2 border-l-amber-300'
        : ''
  const pillBg =
    tone === 'critical'
      ? 'bg-red-50 text-red-700'
      : tone === 'warn'
        ? 'bg-amber-50 text-amber-700'
        : tone === 'neutral'
          ? 'bg-gray-100 text-gray-600'
          : 'bg-emerald-50 text-emerald-700'
  const dot =
    tone === 'critical'
      ? 'bg-red-500'
      : tone === 'warn'
        ? 'bg-amber-500'
        : tone === 'neutral'
          ? 'bg-gray-400'
          : 'bg-emerald-500'
  const valueTone =
    tone === 'critical'
      ? 'text-red-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : 'text-gray-900'
  return (
    <Link
      href={href}
      className={`rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-4 hover:border-gray-300 hover:shadow-md transition-all block ${accent}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {label}
        </p>
        <span
          className={`inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${pillBg}`}
        >
          <span className={`h-1 w-1 rounded-full ${dot}`} aria-hidden="true" />
          {status}
        </span>
      </div>
      <p className={`mt-2 text-xl font-bold font-mono tabular-nums leading-tight ${valueTone}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-gray-500 truncate">{sub}</p>
    </Link>
  )
}

// ================================================================
// StatusCarousel — top-row pillar tile that rotates through 4
// pre-computed metrics on a calm 6s interval. Identity
// (label / status pill / tone / href) stays stable; only the
// metric title + value + sub fade between rotations.
//
// Behavior:
//   • Auto-rotates every ROTATE_MS (6000) once mounted.
//   • Each card is given a different `rotateOffsetMs` (0 / 1500 /
//     3000 / 4500) so the four cards don't pulse together.
//   • Hover / focus pauses rotation — manager-readable while
//     they're reading.
//   • Cross-fade between metrics via two stacked absolutely-
//     positioned layers; the container's min-height keeps the
//     card from jumping when copy lengths differ.
//   • Falls back to the first metric if `metrics.length === 1`
//     (no rotation timer started).
// ================================================================

interface CarouselMetric {
  /** small title above the big value, e.g. "Sales today" */
  title: string
  /** the headline value, e.g. "$39" or "On pace" */
  value: string
  /** the supporting line under the value, e.g. "1 completed order today" */
  sub: string
}

const ROTATE_MS = 6000

function StatusCarousel({
  href,
  label,
  status,
  tone,
  rotateOffsetMs,
  metrics,
}: {
  href: string
  label: string
  status: string
  tone: 'normal' | 'neutral' | 'warn' | 'critical'
  rotateOffsetMs: number
  metrics: CarouselMetric[]
}) {
  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(false)

  const lastRotateRef = useRef<number>(Date.now())
  useEffect(() => {
    if (paused || metrics.length <= 1) return
    // Stagger startup: the first rotation is delayed by
    // rotateOffsetMs so neighboring cards don't tick at the same
    // instant. After that, rotations occur every ROTATE_MS.
    const elapsed = Date.now() - lastRotateRef.current
    const initialDelay = Math.max(0, rotateOffsetMs - elapsed)
    let intervalId: ReturnType<typeof setInterval> | null = null
    const timeoutId = setTimeout(() => {
      setIdx((i) => (i + 1) % metrics.length)
      lastRotateRef.current = Date.now()
      intervalId = setInterval(() => {
        setIdx((i) => (i + 1) % metrics.length)
        lastRotateRef.current = Date.now()
      }, ROTATE_MS)
    }, initialDelay + ROTATE_MS)
    return () => {
      clearTimeout(timeoutId)
      if (intervalId) clearInterval(intervalId)
    }
  }, [paused, rotateOffsetMs, metrics.length])

  // The four pillar cards share identical outer chrome — same
  // border, same shadow, no left-edge accent. Any "this needs
  // attention" signal lives INSIDE the card body via the status
  // pill (top right) and the bottom progress segments. Keeps the
  // strip visually congruent: cards look like quadrants of one
  // surface rather than four cards in different uniforms.
  const pillBg =
    tone === 'critical'
      ? 'bg-red-50 text-red-700'
      : tone === 'warn'
        ? 'bg-amber-50 text-amber-700'
        : tone === 'neutral'
          ? 'bg-gray-100 text-gray-600'
          : 'bg-emerald-50 text-emerald-700'
  const dotClr =
    tone === 'critical'
      ? 'bg-red-500'
      : tone === 'warn'
        ? 'bg-amber-500'
        : tone === 'neutral'
          ? 'bg-gray-400'
          : 'bg-emerald-500'

  return (
    <Link
      href={href}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      aria-label={`${label} — ${metrics[idx]?.title ?? ''}: ${metrics[idx]?.value ?? ''}`}
      className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-4 hover:border-gray-300 hover:shadow-md transition-all block"
    >
      {/* Header — identity row stays stable while inner content rotates. */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {label}
        </p>
        <span
          className={`inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${pillBg}`}
        >
          <span className={`h-1 w-1 rounded-full ${dotClr}`} aria-hidden="true" />
          {status}
        </span>
      </div>

      {/* Rotating content area — two stacked layers cross-fade. The
          container holds a min-height so card height stays stable
          regardless of which metric is showing. */}
      <div className="relative mt-2" style={{ minHeight: '62px' }}>
        {metrics.map((m, i) => (
          <div
            key={i}
            className={`absolute inset-0 transition-opacity duration-500 ${
              i === idx ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            aria-hidden={i === idx ? undefined : 'true'}
          >
            <p className="text-[10px] font-medium text-gray-500 leading-none">{m.title}</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums leading-tight text-gray-900">
              {m.value}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500 truncate">{m.sub}</p>
          </div>
        ))}
      </div>

      {/* Carousel position indicator — four 1px segments at the
          bottom, only the active one filled. Tiny enough to read
          as decoration rather than dots-as-navigation. */}
      {metrics.length > 1 && (
        <div
          className="mt-3 flex items-center gap-1"
          aria-label={`Metric ${idx + 1} of ${metrics.length}`}
        >
          {metrics.map((_, i) => (
            <span
              key={i}
              className={`h-[2px] flex-1 rounded-full transition-colors ${
                i === idx ? dotClr : 'bg-gray-200'
              }`}
            />
          ))}
        </div>
      )}
    </Link>
  )
}

// ================================================================
// Per-pillar metric builders — turn the topCards prop into 4
// CarouselMetric objects. Kept as pure functions next to the
// carousel so the data shape, the format strings, and the fallback
// copy all live in one place. Each builder owns its pillar's
// language (Sales speaks order activity, Staffing speaks coverage,
// Inventory speaks sellability, Finance speaks money truth).
// ================================================================

function buildSalesMetrics(s: Props['topCards']['sales'], t: T): CarouselMetric[] {
  const orderWord = (n: number) =>
    n === 1 ? t('order', 'orden') : t('orders', 'órdenes')
  const completedOrderWord = (n: number) =>
    n === 1 ? t('completed order', 'orden completada') : t('completed orders', 'órdenes completadas')

  const salesTodayMetric: CarouselMetric = {
    title: t('Sales today', 'Ventas de hoy'),
    value: MONEY(s.salesToday),
    sub: s.ordersToday === 0
      ? t('No completed orders yet', 'Sin órdenes completadas aún')
      : `${s.ordersToday} ${completedOrderWord(s.ordersToday)} ${t('today', 'hoy')}`,
  }

  // Average ticket — falls back when there are no orders.
  const avgTicketMetric: CarouselMetric = s.ordersToday > 0
    ? {
        title: t('Average ticket size', 'Ticket promedio'),
        value: MONEY(s.avgTicketToday),
        sub: t('Per completed order', 'Por orden completada'),
      }
    : {
        title: t('Average ticket size', 'Ticket promedio'),
        value: '—',
        sub: t('No ticket data yet', 'Sin datos de ticket aún'),
      }

  // Best seller today — top menu item by quantity today.
  const bestSellerMetric: CarouselMetric = s.bestSeller
    ? {
        title: t('Best seller today', 'Más vendido hoy'),
        value: s.bestSeller.name,
        sub: `${s.bestSeller.count} ${t('sold today', 'vendidos hoy')}`,
      }
    : {
        title: t('Best seller today', 'Más vendido hoy'),
        value: '—',
        sub: t('No items sold yet', 'Sin artículos vendidos aún'),
      }

  // Payment mix — card / cash percentages from today's orders.
  // We surface the two dominant types and only mention "other"
  // when it's meaningful so the line stays calm.
  const paymentMixMetric: CarouselMetric = (() => {
    if (!s.paymentMix || s.paymentMix.total === 0) {
      return { title: t('Payment mix', 'Mezcla de pagos'), value: '—', sub: t('No payment data yet', 'Sin datos de pago aún') }
    }
    const total = s.paymentMix.total
    const pct = (n: number) => Math.round((n / total) * 100)
    const cardPct = pct(s.paymentMix.card)
    const cashPct = pct(s.paymentMix.cash)
    const otherPct = pct(s.paymentMix.other)
    return {
      title: t('Payment mix', 'Mezcla de pagos'),
      value: `${t('Card', 'Tarjeta')} ${cardPct}% · ${t('Cash', 'Efectivo')} ${cashPct}%`,
      sub: s.paymentMix.other > 0
        ? `${t('Other', 'Otro')} ${otherPct}% · ${total} ${orderWord(total)} ${t('today', 'hoy')}`
        : `${total} ${orderWord(total)} ${t('today', 'hoy')}`,
    }
  })()

  return [salesTodayMetric, avgTicketMetric, bestSellerMetric, paymentMixMetric]
}

function buildStaffingMetrics(s: Props['topCards']['staffing'], t: T): CarouselMetric[] {
  const shiftWord = (n: number) =>
    n === 1 ? t('shift', 'turno') : t('shifts', 'turnos')

  const shiftsTodayMetric: CarouselMetric = {
    title: t('Shifts today', 'Turnos hoy'),
    value: s.shiftsToday === 0
      ? '—'
      : `${s.shiftsToday} ${shiftWord(s.shiftsToday)}`,
    sub: s.shiftsToday === 0
      ? t('No shifts today', 'Sin turnos hoy')
      : `${s.hoursToday.toFixed(1)}h ${t('scheduled', 'programadas')}`,
  }

  const activeEmployeesMetric: CarouselMetric = {
    title: t('Active employees', 'Empleados activos'),
    value: s.activeStaff === 0 ? '—' : `${s.activeStaff} ${t('active', 'activos')}`,
    sub: s.activeStaff === 0
      ? t('No active employees', 'Sin empleados activos')
      : t('Available on the team', 'Disponibles en el equipo'),
  }

  // Labor estimate today — hours × hourly_rate over today's rated
  // shifts. Clearly labeled "estimate" so it can't be confused
  // with bank-settled labor cost (Finance owns that).
  const laborEstimateMetric: CarouselMetric = s.laborEstimateToday !== null
    ? {
        title: t('Labor estimate', 'Estimación de mano de obra'),
        value: MONEY(s.laborEstimateToday),
        sub: t('Scheduled labor estimate', 'Mano de obra programada estimada'),
      }
    : {
        title: t('Labor estimate', 'Estimación de mano de obra'),
        value: '—',
        sub: t('Labor estimate unavailable', 'Estimación de mano de obra no disponible'),
      }

  // House coverage — FOH / BOH split of today's shifts. Falls back
  // when no shift carries a section.area so we don't fake a split.
  const houseCoverageMetric: CarouselMetric = s.houseCoverage
    ? {
        title: t('House coverage', 'Cobertura de salón'),
        value: `FOH ${s.houseCoverage.foh} · BOH ${s.houseCoverage.boh}`,
        sub: t('Scheduled by house', 'Programado por área'),
      }
    : {
        title: t('House coverage', 'Cobertura de salón'),
        value: '—',
        sub: t('No house coverage yet', 'Sin cobertura aún'),
      }

  return [shiftsTodayMetric, activeEmployeesMetric, laborEstimateMetric, houseCoverageMetric]
}

function buildInventoryMetrics(i: Props['topCards']['inventory'], t: T): CarouselMetric[] {
  const outMetric: CarouselMetric = {
    title: t('Out items', 'Artículos agotados'),
    value: i.outItems === 0 ? '—' : `${i.outItems} ${t('out', 'agotados')}`,
    sub: i.outItems === 0 ? t('No out items', 'Sin artículos agotados') : t('Needs attention', 'Requiere atención'),
  }
  const lowMetric: CarouselMetric = {
    title: t('Low stock', 'Bajo inventario'),
    value: i.lowItems === 0 ? '—' : `${i.lowItems} ${t('low', 'bajos')}`,
    sub: i.lowItems === 0 ? t('No low-stock items', 'Sin artículos bajos') : t('Below threshold', 'Bajo el umbral'),
  }

  // Inventory cost — explicitly labeled "Recorded" since this comes
  // from manually-logged inventory_related expenses, not bank-
  // settled inventory cost (no separable settled figure exposed).
  const inventoryCostMetric: CarouselMetric = i.recordedInventoryCost30d > 0
    ? {
        title: t('Inventory cost', 'Costo de inventario'),
        value: MONEY(i.recordedInventoryCost30d),
        sub: t('Recorded inventory cost · last 30d', 'Costo de inventario registrado · últimos 30d'),
      }
    : {
        title: t('Inventory cost', 'Costo de inventario'),
        value: '—',
        sub: t('No inventory cost yet', 'Sin costo de inventario aún'),
      }

  // Pending restock orders — draft + ordered are both "pending"
  // (one's pre-place, the other's awaiting receipt). Combine for
  // the headline number; show the split in the sub if useful.
  const pendingTotal = i.pendingRestocks.drafts + i.pendingRestocks.ordered
  const restockMetric: CarouselMetric = pendingTotal === 0
    ? {
        title: t('Pending restock orders', 'Reabastecimientos pendientes'),
        value: '—',
        sub: t('No pending restocks', 'Sin reabastecimientos pendientes'),
      }
    : {
        title: t('Pending restock orders', 'Reabastecimientos pendientes'),
        value: `${pendingTotal} ${t('pending', 'pendientes')}`,
        sub: i.pendingRestocks.ordered > 0
          ? `${i.pendingRestocks.ordered} ${t('awaiting receipt', 'esperando recepción')}${
              i.pendingRestocks.drafts > 0 ? ` · ${i.pendingRestocks.drafts} ${t('in cart', 'en carrito')}` : ''
            }`
          : `${i.pendingRestocks.drafts} ${t('in cart', 'en carrito')}`,
      }

  return [outMetric, lowMetric, inventoryCostMetric, restockMetric]
}

function buildFinanceMetrics(f: Props['topCards']['finance'], t: T): CarouselMetric[] {
  const reviewMetric: CarouselMetric = f.moneyReview.attention === 0
    ? {
        title: t('Money review', 'Revisión de dinero'),
        value: '—',
        sub: t('No money items need review', 'Sin elementos por revisar'),
      }
    : {
        title: t('Money review', 'Revisión de dinero'),
        value: f.moneyReview.attention === 1
          ? `${f.moneyReview.attention} ${t('needs attention', 'requiere atención')}`
          : `${f.moneyReview.attention} ${t('need attention', 'requieren atención')}`,
        sub: t('Deposits, exceptions, or mismatches', 'Depósitos, excepciones o discrepancias'),
      }

  const depositsMetric: CarouselMetric = f.depositsToConfirm === 0
    ? {
        title: t('Deposits to confirm', 'Depósitos por confirmar'),
        value: '—',
        sub: t('No deposits pending', 'Sin depósitos pendientes'),
      }
    : {
        title: t('Deposits to confirm', 'Depósitos por confirmar'),
        value: `${f.depositsToConfirm} ${t('pending', 'pendientes')}`,
        sub: t('Sales deposits to match', 'Depósitos de ventas por conciliar'),
      }

  // Estimated operating expense — non-inventory expense rows in
  // the 30-day window. Explicitly labeled "estimated" since it
  // doesn't yet incorporate bank-confirmed signals; Inventory
  // owns "Recorded inventory cost" and Staffing owns "Labor
  // estimate" so this card avoids repeating them.
  const operatingMetric: CarouselMetric = f.operatingEstimate30d > 0
    ? {
        title: t('Estimated operating expense', 'Gasto operativo estimado'),
        value: `${MONEY(f.operatingEstimate30d)} ${t('estimated', 'estimado')}`,
        sub: t('Operating spend estimate · last 30d', 'Estimación de gasto operativo · últimos 30d'),
      }
    : {
        title: t('Estimated operating expense', 'Gasto operativo estimado'),
        value: '—',
        sub: t('No operating estimate yet', 'Sin estimación operativa aún'),
      }

  const syncMetric: CarouselMetric = f.bankSyncedAt
    ? {
        title: t('Last bank sync', 'Última sincronización bancaria'),
        value: `${t('Synced', 'Sincronizado')} ${formatTime(f.bankSyncedAt)}`,
        sub: t('Bank context current', 'Contexto bancario actualizado'),
      }
    : {
        title: t('Last bank sync', 'Última sincronización bancaria'),
        value: '—',
        sub: t('Bank not synced yet', 'Banco aún no sincronizado'),
      }

  return [reviewMetric, depositsMetric, operatingMetric, syncMetric]
}

// Compact "X minutes / hours / days ago" used by the carousel's
// latest-sale metric. Kept local to the carousel so the rest of
// the dashboard's time formatting stays untouched.
function relativeTimeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const diffMs = Date.now() - then
  if (diffMs < 0) return 'Just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// ================================================================
// OperatingPressureCard — full-chart weekly pressure read.
//
// The chart is the entire body; no bottom interpretation block.
// Each day renders a bar whose height represents the day's
// pressure score (sales demand × inventory-risk multiplier).
// Hover a column for full breakdown via tooltip.
//
// Pressure score (per day):
//   pressureScore = salesNormalized × inventoryMultiplier
//
// Where:
//   salesNormalized   = day's sales / max day's sales (0..1)
//   inventoryMultiplier = 1 + (0.05 × stockPressure), capped at 1.5
//
// Days with zero sales score zero; days with sales lean higher
// when inventory pressure is also active. Today is highlighted
// via a darker bar; no-coverage days on a sales day get an amber
// risk marker (small triangle) at the top of the bar.
//
// Tooltip on hover/focus surfaces: weekday, sales, staffing
// (shifts + scheduled hours derivable from shift count via
// approximate average), and the inventory risk count.
// ================================================================
function OperatingPressureCard({
  salesByDay,
  shiftsByDay,
  todayIdx,
  outItems,
  lowItems,
  t,
}: {
  salesByDay: { label: string; value: number; orders: number; date: string }[]
  shiftsByDay: { label: string; value: number; employees: number; date: string }[]
  todayIdx: number
  outItems: number
  lowItems: number
  t: T
}) {
  // English short day labels → Spanish short day labels.
  // Server ships English keys ('Mon'..'Sun'); we localize for render.
  const DAY_LABEL_ES: Record<string, string> = {
    Mon: 'Lun', Tue: 'Mar', Wed: 'Mié', Thu: 'Jue',
    Fri: 'Vie', Sat: 'Sáb', Sun: 'Dom',
  }
  const localDayLabel = (en: string) => t(en, DAY_LABEL_ES[en] ?? en)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const stockPressure = outItems + lowItems
  const inventoryMultiplier = Math.min(1.5, 1 + 0.05 * stockPressure)

  const maxSales = Math.max(0, ...salesByDay.map((d) => d.value))
  const hasAnySales = maxSales > 0

  // Per-day pressure score (0..1). When there are no sales at all,
  // every day is zero — the chart still renders neutral baselines
  // so the card never collapses.
  const pressureByDay = salesByDay.map((d) => {
    if (!hasAnySales) return 0
    const salesNorm = d.value / maxSales
    return Math.min(1, salesNorm * inventoryMultiplier)
  })

  // Detect language from the translator (a tiny sentinel: only the
  // Spanish branch returns the alternate string).
  const isEs = t('__lang_probe__', 'es') === 'es'
  const localeForDate = isEs ? 'es-ES' : 'en-US'
  const formatDayDate = (iso: string) =>
    new Date(iso).toLocaleDateString(localeForDate, { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    // overflow-visible (not overflow-hidden) so the hover tooltip
    // can extend above the chart without being clipped by the
    // card's rounded mask.
    <div className="lg:col-span-3 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-visible flex flex-col">
      {/* Header */}
      <div className="border-b border-gray-100 px-5 py-3">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {t('Operating pressure', 'Presión operativa')}
        </p>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
          {t('Where sales, coverage, and stock risk overlap.', 'Donde ventas, cobertura y riesgo de inventario coinciden.')}
        </p>
      </div>

      {/* Chart body — fills the rest of the card. Extra top padding
          gives the tooltip vertical room above the tallest bars. */}
      <div className="flex-1 px-5 pt-10 pb-4 relative">
        {!hasAnySales && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-[11px] text-gray-400 italic">{t('Not enough activity yet', 'Aún no hay actividad suficiente')}</p>
          </div>
        )}

        {/* Chart area */}
        <div className="grid grid-cols-7 gap-3 items-end" style={{ minHeight: '180px' }}>
          {salesByDay.map((d, i) => {
            const shifts = shiftsByDay[i]?.value ?? 0
            const isToday = i === todayIdx
            const isHovered = hoverIdx === i
            const score = pressureByDay[i]
            const barHeightPx = Math.max(hasAnySales && d.value > 0 ? 8 : 2, Math.round(score * 150))
            const noCoverageOnSalesDay = d.value > 0 && shifts === 0
            const baseBar = isToday
              ? 'bg-gray-900'
              : isHovered
                ? 'bg-blue-500'
                : score > 0.66
                  ? 'bg-blue-500'
                  : score > 0.33
                    ? 'bg-blue-400'
                    : score > 0
                      ? 'bg-blue-300'
                      : 'bg-gray-200'

            return (
              <button
                key={i}
                type="button"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx((cur) => (cur === i ? null : cur))}
                onFocus={() => setHoverIdx(i)}
                onBlur={() => setHoverIdx((cur) => (cur === i ? null : cur))}
                className="group relative flex flex-col items-center justify-end h-full focus:outline-none"
                aria-label={`${localDayLabel(d.label)} ${formatDayDate(d.date)} — ${t('pressure', 'presión')} ${Math.round(score * 100)}%`}
              >
                {/* Risk marker — small amber chip above the bar
                    when there's a sales day with zero coverage.
                    Single signal, no clutter. */}
                {noCoverageOnSalesDay && (
                  <span
                    className="mb-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 border border-amber-500"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={`w-full rounded-t-md transition-all ${baseBar} ${
                    isHovered ? 'shadow-[0_-2px_8px_-2px_rgba(15,23,42,0.15)]' : ''
                  }`}
                  style={{ height: `${barHeightPx}px` }}
                />
                <p
                  className={`mt-1.5 text-[10px] font-semibold uppercase tracking-widest ${
                    isToday ? 'text-gray-900' : 'text-gray-400'
                  }`}
                >
                  {localDayLabel(d.label)}
                </p>

                {/* Tooltip — dynamically anchored to the bar.
                    Vertical: `bottom` is computed from the bar's
                    pixel height so the tooltip rises with the bar
                    (Fri's tall bar pushes the tooltip up; Mon's
                    short bar keeps it near the chart floor) — the
                    tooltip always sits just above the bar's top
                    edge with a small gap.
                    Horizontal: first column aligns left, last
                    column aligns right, all others center on the
                    bar. Keeps the tooltip on-card regardless of
                    which day you hover. */}
                {isHovered && (
                  <div
                    className={`absolute z-20 w-52 rounded-md border border-gray-200 bg-white shadow-lg px-3 py-2 text-left pointer-events-none ${
                      i === 0
                        ? 'left-0'
                        : i === salesByDay.length - 1
                          ? 'right-0'
                          : 'left-1/2 -translate-x-1/2'
                    }`}
                    // Day label (~16px) + small gap (10px) sits
                    // below the bar; bar height varies; tooltip
                    // bottom = label/gap + bar height + 8px gap
                    // above the bar.
                    style={{ bottom: `${barHeightPx + 30}px` }}
                  >
                    <p className="text-[11px] font-semibold text-gray-900 leading-tight">
                      {formatDayDate(d.date)}
                    </p>
                    <p className="mt-1.5 text-[10px] text-gray-600">
                      {t('Sales', 'Ventas')}:{' '}
                      <span className="font-semibold text-gray-800 font-mono tabular-nums">{MONEY(d.value)}</span>
                      {d.orders > 0 && (
                        <span className="text-gray-500"> · {d.orders} {d.orders === 1 ? t('order', 'orden') : t('orders', 'órdenes')}</span>
                      )}
                    </p>
                    <p className="text-[10px] text-gray-600">
                      {t('Staffing', 'Personal')}:{' '}
                      <span className="font-semibold text-gray-800 font-mono tabular-nums">
                        {shifts === 0 ? t('No shifts', 'Sin turnos') : `${shifts} ${shifts === 1 ? t('shift', 'turno') : t('shifts', 'turnos')}`}
                      </span>
                    </p>
                    <p className="text-[10px] text-gray-600">
                      {t('Inventory risk', 'Riesgo de inventario')}:{' '}
                      <span className={`font-semibold font-mono tabular-nums ${stockPressure > 0 ? 'text-amber-700' : 'text-gray-800'}`}>
                        {stockPressure} {stockPressure === 1 ? t('item at risk', 'artículo en riesgo') : t('items at risk', 'artículos en riesgo')}
                      </span>
                    </p>
                    <p className="mt-1.5 text-[10px] text-gray-500">
                      {t('Pressure', 'Presión')}:{' '}
                      <span className="font-semibold text-gray-800">
                        {!hasAnySales || d.value === 0
                          ? t('None', 'Ninguna')
                          : score > 0.75
                            ? t('High', 'Alta')
                            : score > 0.5
                              ? t('Elevated', 'Elevada')
                              : score > 0.25
                                ? t('Moderate', 'Moderada')
                                : t('Low', 'Baja')}
                      </span>
                    </p>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ================================================================
// QuickActionsCard — the right half of the middle row.
//
// Five compact action rows for the most common manager flows.
// Each row navigates to the relevant pillar page; the Log manual
// expense action deep-links to /finance?log=1 which the Finance
// page already handles by opening the Log Expense drawer on
// mount. Designed to be scannable rather than dense.
// ================================================================
function QuickActionsCard({ t }: { t: T }) {
  // Four manager flows. `/finance?log=1` deep-links into the
  // Log Expense drawer that the Finance client already handles on
  // mount; the other three land on their pillar page where the
  // relevant workflow lives.
  const actions: Array<{
    href: string
    title: string
    description: string
  }> = [
    {
      href: '/finance?log=1',
      title: t('Log Expense', 'Registrar gasto'),
      description: t('Record a cash, owner-paid, or one-off expense.', 'Registra un gasto en efectivo, pagado por el dueño o único.'),
    },
    {
      href: '/inventory',
      title: t('Create Restock Order', 'Crear orden de reabastecimiento'),
      description: t('Replenish low or out items.', 'Reabastece artículos bajos o agotados.'),
    },
    {
      href: '/staffing',
      title: t('Add Shift', 'Agregar turno'),
      description: t('Fill a schedule gap.', 'Cubre un hueco en el horario.'),
    },
    {
      href: '/finance',
      title: t('Review Bank Transactions', 'Revisar transacciones bancarias'),
      description: t('Review deposits, exceptions, and bank activity.', 'Revisa depósitos, excepciones y actividad bancaria.'),
    },
  ]

  return (
    <div className="lg:col-span-2 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col">
      <div className="border-b border-gray-100 px-5 py-3">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {t('Quick actions', 'Acciones rápidas')}
        </p>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
          {t('Jump into common manager tasks.', 'Acceso directo a tareas comunes del gerente.')}
        </p>
      </div>
      <ul className="flex-1 divide-y divide-gray-100">
        {actions.map((a) => (
          <li key={a.title}>
            <Link
              href={a.href}
              className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50 transition-colors group"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-gray-900 leading-snug">
                  {a.title}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
                  {a.description}
                </p>
              </div>
              <span className="text-[11px] font-medium text-blue-700 group-hover:text-blue-800 group-hover:translate-x-0.5 transition-all flex-shrink-0 mt-0.5 whitespace-nowrap">
                {t('Open', 'Abrir')} →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ================================================================
// Manager To-Do — localStorage-backed checklist
//
// Replaces the old system-driven Daily Readiness card. The list is
// editable end-to-end via the Manage drawer. Persistence is
// localStorage-only for this pass — explicit in the report. Items
// are seeded from DEFAULT_TODO_ITEMS on first load (no stored
// state). Completed state is per-day so the list "resets" each
// morning rather than requiring the manager to uncheck yesterday.
// ================================================================

interface TodoItem {
  id: string
  label: string
  hint?: string
}

const TODO_ITEMS_KEY = 'dashboard.todo.items.v1'
const TODO_COMPLETED_KEY = 'dashboard.todo.completed.v1'

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

// Read items + per-day completion from localStorage. Returns
// defaults if nothing is stored or the stored value is malformed.
function loadTodoItems(defaults: TodoItem[]): TodoItem[] {
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(TODO_ITEMS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as TodoItem[]
    if (!Array.isArray(parsed) || parsed.length === 0) return defaults
    return parsed
  } catch {
    return defaults
  }
}
function saveTodoItems(items: TodoItem[]): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(TODO_ITEMS_KEY, JSON.stringify(items)) } catch { /* noop */ }
}
function loadCompletedIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(TODO_COMPLETED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as { day: string; ids: string[] }
    if (!parsed || parsed.day !== todayKey()) return new Set()
    return new Set(parsed.ids)
  } catch {
    return new Set()
  }
}
function saveCompletedIds(ids: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      TODO_COMPLETED_KEY,
      JSON.stringify({ day: todayKey(), ids: [...ids] }),
    )
  } catch { /* noop */ }
}

// Module-level event channel so the card + drawer can update each
// other's view of the list without prop drilling. Simple custom
// event — fired when the drawer commits a save.
const TODO_CHANGE_EVENT = 'dashboard:todo-items-changed'

const TODO_PAGE_SIZE = 5

function ManagerTodoCard({
  defaultItems,
  onOpenManager,
  t,
}: {
  defaultItems: TodoItem[]
  onOpenManager: () => void
  t: T
}) {
  const [items, setItems] = useState<TodoItem[]>(defaultItems)
  const [completed, setCompleted] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  // Hydration-safe: read storage after mount so SSR / first render
  // matches between server and client.
  useEffect(() => {
    setItems(loadTodoItems(defaultItems))
    setCompleted(loadCompletedIds())
    // If the saved list shrinks between visits, snap back to page 0
    // so we never land on a now-empty page.
    setPage(0)
    const onChange = () => {
      setItems(loadTodoItems(defaultItems))
      setPage(0)
    }
    window.addEventListener(TODO_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(TODO_CHANGE_EVENT, onChange)
  }, [])

  function toggle(id: string) {
    setCompleted((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveCompletedIds(next)
      return next
    })
  }

  const doneCount = items.reduce((n, it) => n + (completed.has(it.id) ? 1 : 0), 0)

  // Pagination — render TODO_PAGE_SIZE items at a time so the card
  // stays visually balanced with its neighbors no matter how long
  // the manager's list grows. Controls are only rendered when the
  // list actually exceeds one page.
  const pageCount = Math.max(1, Math.ceil(items.length / TODO_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const startIdx = safePage * TODO_PAGE_SIZE
  const visibleItems = items.slice(startIdx, startIdx + TODO_PAGE_SIZE)
  const hasPagination = items.length > TODO_PAGE_SIZE

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col">
      <div className="border-b border-gray-100 px-4 py-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            {t('Manager to-do', 'Pendientes del gerente')}
          </p>
          <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
            {t('Opening, closing, and daily checks.', 'Apertura, cierre y revisiones diarias.')}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className="text-[10px] font-semibold font-mono tabular-nums text-gray-500">
            {doneCount}/{items.length}
          </span>
          <button
            type="button"
            onClick={onOpenManager}
            className="text-[10px] font-semibold uppercase tracking-[0.06em] text-blue-700 hover:text-blue-800 transition-colors"
          >
            {t('Manage', 'Gestionar')}
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-gray-400">{t('No checklist items yet.', 'Sin elementos aún.')}</p>
          <button
            type="button"
            onClick={onOpenManager}
            className="mt-2 text-[11px] font-semibold text-blue-700 hover:text-blue-800"
          >
            {t('Add the first item', 'Agregar el primer elemento')} →
          </button>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-gray-100 flex-1">
            {visibleItems.map((it) => {
              const isDone = completed.has(it.id)
              return (
                <li key={it.id}>
                  <label className="px-4 py-2.5 flex items-start gap-2.5 cursor-pointer hover:bg-gray-50/60 transition-colors select-none">
                    <input
                      type="checkbox"
                      checked={isDone}
                      onChange={() => toggle(it.id)}
                      className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500/40"
                    />
                    <div className="min-w-0 flex-1">
                      <p className={`text-xs leading-snug ${isDone ? 'line-through text-gray-400' : 'font-medium text-gray-800'}`}>
                        {it.label}
                      </p>
                      {it.hint && (
                        <p className={`mt-0.5 text-[10px] leading-relaxed ${isDone ? 'text-gray-300 line-through' : 'text-gray-500'}`}>
                          {it.hint}
                        </p>
                      )}
                    </div>
                  </label>
                </li>
              )
            })}
          </ul>
          {/* Page break — visible separator + prev/next pager.
              Only rendered when there's actually a second page so
              short lists stay calm. */}
          {hasPagination && (
            <div className="border-t border-gray-100 px-4 py-2 flex items-center justify-between gap-2 bg-gray-50/40">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-600 hover:text-gray-800 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                ← {t('Prev', 'Atrás')}
              </button>
              <span className="text-[10px] font-semibold font-mono tabular-nums text-gray-500">
                {t('Page', 'Página')} {safePage + 1} {t('of', 'de')} {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
                className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-600 hover:text-gray-800 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                {t('Next', 'Siguiente')} →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ================================================================
// ManagerTodoDrawer — manage the checklist (edit / add / remove).
//
// Persistence: localStorage only (TODO_ITEMS_KEY). Save fires a
// `dashboard:todo-items-changed` event so the card refetches its
// items immediately, no page reload required.
//
// Reordering is not implemented in this pass — out-of-scope per
// the V1 brief. Items render in insertion order.
// ================================================================
function ManagerTodoDrawer({
  open,
  onClose,
  t,
}: {
  open: boolean
  onClose: () => void
  t: T
}) {
  // The drawer is a *live* view of the persisted list: every add /
  // delete / edit commits immediately to localStorage and fires the
  // change event so the card mirrors the change. No Save / Cancel
  // ceremony — the manager's intent is the action.
  const [items, setItems] = useState<TodoItem[]>([])
  const [completed, setCompleted] = useState<Set<string>>(new Set())
  // When non-null, that one row is in edit mode; everyone else
  // renders as a normal checklist row (same shape as the card).
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setItems(loadTodoItems(defaultTodoItems(t)))
      setCompleted(loadCompletedIds())
      setEditingId(null)
    }
  }, [open, t])

  // Single commit path — writes through to localStorage and lets
  // the dashboard card refresh from the same source of truth.
  function commit(next: TodoItem[]) {
    setItems(next)
    saveTodoItems(next)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(TODO_CHANGE_EVENT))
    }
  }

  function updateItem(id: string, patch: Partial<TodoItem>) {
    const next = items.map((it) => (it.id === id ? { ...it, ...patch } : it))
    commit(next)
  }
  function removeItem(id: string) {
    const next = items.filter((it) => it.id !== id)
    commit(next)
    if (editingId === id) setEditingId(null)
  }
  function addItem() {
    const id = `custom-${Date.now()}`
    const newItem: TodoItem = { id, label: t('New task', 'Nueva tarea'), hint: undefined }
    const next = [...items, newItem]
    commit(next)
    // Auto-open the new row in edit mode so the manager can type
    // straight in. The title input autofocuses when editing.
    setEditingId(id)
  }
  function toggleCompleted(id: string) {
    setCompleted((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveCompletedIds(next)
      return next
    })
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — explicit z-0 so it sits BELOW the panel.
          Required because the panel is a static flex item; without
          this, CSS would paint the absolutely-positioned backdrop
          on top of the panel and swallow every click. */}
      <button
        type="button"
        aria-label={t('Close drawer', 'Cerrar panel')}
        onClick={onClose}
        className="absolute inset-0 bg-gray-900/30 z-0"
      />
      {/* Panel — relative + z-10 so it captures its own clicks. */}
      <aside className="relative z-10 ml-auto h-full w-full max-w-md md:max-w-lg lg:max-w-md bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-100 px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              {t('Dashboard checklist', 'Lista del panel')}
            </p>
            <h2 className="mt-0.5 text-base font-semibold tracking-tight text-gray-900">
              {t('Manage To-Do List', 'Gestionar lista de pendientes')}
            </h2>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              {t('Tap a row to edit. Changes save automatically to this browser.', 'Toca una fila para editar. Los cambios se guardan automáticamente en este navegador.')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-semibold text-gray-500 hover:text-gray-700"
          >
            {t('Close', 'Cerrar')}
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-xs text-gray-400 italic">{t('No items yet — add one below.', 'Sin elementos aún — agrega uno abajo.')}</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {items.map((it) => {
                const isEditing = editingId === it.id
                const isDone = completed.has(it.id)
                if (isEditing) {
                  return (
                    <li key={it.id} className="px-5 py-3 bg-blue-50/40">
                      <TodoEditRow
                        item={it}
                        onChange={(patch) => updateItem(it.id, patch)}
                        onRemove={() => removeItem(it.id)}
                        onDone={() => setEditingId(null)}
                        t={t}
                      />
                    </li>
                  )
                }
                // Display row — same shape as the dashboard card.
                return (
                  <li key={it.id}>
                    <div className="px-5 py-2.5 flex items-start gap-2.5 group">
                      <input
                        type="checkbox"
                        checked={isDone}
                        onChange={() => toggleCompleted(it.id)}
                        className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500/40 flex-shrink-0"
                        aria-label={`${t('Toggle', 'Alternar')} ${it.label}`}
                      />
                      <button
                        type="button"
                        onClick={() => setEditingId(it.id)}
                        className="min-w-0 flex-1 text-left focus:outline-none"
                      >
                        <p className={`text-xs leading-snug ${isDone ? 'line-through text-gray-400' : 'font-medium text-gray-800'}`}>
                          {it.label}
                        </p>
                        {it.hint && (
                          <p className={`mt-0.5 text-[10px] leading-relaxed ${isDone ? 'text-gray-300 line-through' : 'text-gray-500'}`}>
                            {it.hint}
                          </p>
                        )}
                      </button>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-300 group-hover:text-gray-500 transition-colors flex-shrink-0 mt-1">
                        {t('Edit', 'Editar')}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {/* Add to list — compact black pill below the list.
              Creates a placeholder item and immediately opens it
              for edit. */}
          <div className="px-5 py-3 border-t border-gray-100 flex justify-center">
            <button
              type="button"
              onClick={addItem}
              className="inline-flex items-center text-[11px] font-semibold rounded-md bg-gray-900 text-white px-3 py-1.5 hover:bg-gray-800 transition-colors"
            >
              + {t('Add to list', 'Agregar a la lista')}
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

// ----------------------------------------------------------------
// TodoEditRow — inline editor for a single checklist item. Used
// only inside ManagerTodoDrawer when an item is in edit mode.
// Auto-focuses the title input on mount so the manager can type
// straight into a newly-added row.
// ----------------------------------------------------------------
function TodoEditRow({
  item,
  onChange,
  onRemove,
  onDone,
  t,
}: {
  item: TodoItem
  onChange: (patch: Partial<TodoItem>) => void
  onRemove: () => void
  onDone: () => void
  t: T
}) {
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])
  return (
    <div className="space-y-2.5">
      <div>
        <label
          htmlFor={`todo-title-${item.id}`}
          className="block text-[9px] font-semibold uppercase tracking-[0.12em] text-gray-400 mb-1"
        >
          {t('Title', 'Título')}
        </label>
        <input
          ref={titleRef}
          id={`todo-title-${item.id}`}
          type="text"
          value={item.label}
          onChange={(e) => onChange({ label: e.target.value })}
          onBlur={(e) => {
            // If the manager blurs leaving an empty title, treat
            // it as a request to drop the row. Prevents lingering
            // blank rows from showing up on the card.
            if (e.target.value.trim() === '') onRemove()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault()
              onDone()
            }
          }}
          className="w-full text-xs font-semibold text-gray-900 bg-white border border-gray-200 rounded-md px-2 py-1.5 outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
          placeholder={t('Task title', 'Título de la tarea')}
        />
      </div>
      <div>
        <label
          htmlFor={`todo-hint-${item.id}`}
          className="block text-[9px] font-semibold uppercase tracking-[0.12em] text-gray-400 mb-1"
        >
          {t('Description', 'Descripción')} <span className="text-gray-300 normal-case tracking-normal font-normal">({t('optional', 'opcional')})</span>
        </label>
        <input
          id={`todo-hint-${item.id}`}
          type="text"
          value={item.hint ?? ''}
          onChange={(e) => onChange({ hint: e.target.value || undefined })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault()
              onDone()
            }
          }}
          className="w-full text-[11px] text-gray-700 bg-white border border-gray-200 rounded-md px-2 py-1.5 outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 placeholder:text-gray-400"
          placeholder={t('Helper text shown under the title', 'Texto de ayuda mostrado bajo el título')}
        />
      </div>
      <div className="flex items-center justify-between pt-0.5">
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] font-semibold uppercase tracking-[0.06em] text-red-600 hover:text-red-700"
        >
          {t('Remove', 'Eliminar')}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-[11px] font-semibold rounded-md bg-gray-900 text-white px-3 py-1.5 hover:bg-gray-800 transition-colors"
        >
          {t('Done', 'Listo')}
        </button>
      </div>
    </div>
  )
}

// ================================================================
// NextShiftCard — dynamic "Next Shift / Clock-In Check" card.
//
// Two modes, chosen by the current clock:
//
//   Clock-In Check   : a shift began within the last hour. Card
//                      shows "Clock-In Check", the shift start
//                      time, and the staff scheduled to clock in.
//                      All staff sharing that start time are
//                      grouped, regardless of role / FOH / BOH.
//
//   Next Shift       : the soonest upcoming shift group. Same
//                      grouping rule — everyone starting at the
//                      same moment shows together.
//
// CLOCK-IN DATA LIMITATION:
//   The schema doesn't carry a per-shift clocked_in_at column
//   yet, so the Clock-In Check mode renders a future-ready
//   "Scheduled to clock in" placeholder rather than a real check
//   state. Wiring real clock-in data is reported as a follow-up.
//
// Re-evaluates every minute so the card flips between modes
// without a page refresh.
// ================================================================

const CLOCK_IN_WINDOW_MS = 60 * 60 * 1000

interface UpcomingShift {
  id: string
  employeeName: string
  role: string
  startTime: string
  endTime: string
}

function groupByStartTime(shifts: UpcomingShift[]): { startTime: string; endTime: string; staff: UpcomingShift[] }[] {
  const groups = new Map<string, { startTime: string; endTime: string; staff: UpcomingShift[] }>()
  for (const s of shifts) {
    const existing = groups.get(s.startTime)
    if (existing) existing.staff.push(s)
    else groups.set(s.startTime, { startTime: s.startTime, endTime: s.endTime, staff: [s] })
  }
  return [...groups.values()]
}

function NextShiftCard({ upcomingShifts, t }: { upcomingShifts: UpcomingShift[]; t: T }) {
  // Re-evaluate every 60s so the card flips between modes without
  // a refresh. `tick` is just a dependency to force re-render.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const now = Date.now()
  const grouped = groupByStartTime(upcomingShifts)
  const activeGroup = grouped.find((g) => {
    const t = new Date(g.startTime).getTime()
    return t <= now && now - t < CLOCK_IN_WINDOW_MS
  })
  const nextGroup = activeGroup
    ? null
    : grouped.find((g) => new Date(g.startTime).getTime() > now) ?? null

  const isEs = t('__lang_probe__', 'es') === 'es'
  const locale = isEs ? 'es-ES' : 'en-US'
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  const fmtDateShort = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col">
      {activeGroup ? (
        <>
          {/* Clock-In Check mode */}
          <div className="border-b border-gray-100 px-4 py-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-700">
                {t('Clock-in check', 'Verificación de entrada')}
              </p>
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                {fmtTime(activeGroup.startTime)} {t('shift · staff scheduled to clock in.', 'turno · personal programado para entrar.')}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 flex-shrink-0">
              <span className="h-1 w-1 rounded-full bg-blue-500" />
              {t('Active', 'Activo')}
            </span>
          </div>
          <ul className="divide-y divide-gray-100">
            {activeGroup.staff.map((s) => (
              <li key={s.id} className="px-4 py-2.5">
                <p className="text-sm font-semibold text-gray-900 truncate">{s.employeeName}</p>
                <p className="mt-0.5 text-[11px] text-gray-500">
                  {s.role || '—'}
                  <span className="text-gray-300 px-1">·</span>
                  {t('Scheduled to clock in', 'Programado para entrar')}
                </p>
              </li>
            ))}
          </ul>
          <p className="px-4 py-2.5 text-[10px] text-gray-400 italic border-t border-gray-100">
            {t('Clock-in tracking coming soon — showing scheduled staff.', 'Seguimiento de entrada próximamente — mostrando personal programado.')}
          </p>
        </>
      ) : nextGroup ? (
        <>
          {/* Next Shift mode */}
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              {t('Next shift', 'Próximo turno')}
            </p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              {t('Upcoming scheduled staff.', 'Personal próximamente programado.')}
            </p>
          </div>
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-[12px] font-mono tabular-nums font-semibold text-gray-900">
              {fmtTime(nextGroup.startTime)} – {fmtTime(nextGroup.endTime)}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500 font-mono tabular-nums">
              {fmtDateShort(nextGroup.startTime)}
            </p>
          </div>
          <ul className="divide-y divide-gray-100">
            {nextGroup.staff.map((s) => (
              <li key={s.id} className="px-4 py-2.5">
                <p className="text-sm font-semibold text-gray-900 truncate">{s.employeeName}</p>
                <p className="mt-0.5 text-[11px] text-gray-500">{s.role || '—'}</p>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              {t('Next shift', 'Próximo turno')}
            </p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              {t('Upcoming scheduled staff.', 'Personal próximamente programado.')}
            </p>
          </div>
          <div className="px-4 py-4">
            <p className="text-sm font-semibold text-gray-900">{t('No upcoming shifts', 'Sin próximos turnos')}</p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              {t('Schedule is clear for the selected window.', 'El horario está libre en la ventana seleccionada.')}
            </p>
          </div>
        </>
      )}
    </div>
  )
}

// ================================================================
// MovementRow — one row in Recent Movement. Standardized 3-line
// vertical anatomy: source label (uppercase eyebrow) → main activity
// (semibold value) → time/context (muted). Renders an em dash when
// the corresponding stream has no data yet so the card stays calm
// rather than empty.
// ================================================================
function MovementRow({
  label,
  value,
  when,
  relative,
  t,
}: {
  label: string
  value: string | null
  when: string | null
  relative: boolean
  t: T
}) {
  return (
    <li className="px-4 py-2.5">
      <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm font-mono tabular-nums truncate ${
          value ? 'font-semibold text-gray-900' : 'text-gray-400'
        }`}
      >
        {value ?? '—'}
      </p>
      {when && (
        <p className="mt-0.5 text-[11px] text-gray-500">
          {relative ? fmtRelative(when, t) : fmtDateOnly(when)}
        </p>
      )}
    </li>
  )
}

// ================================================================
// Bands (md+) pieces — only rendered by the isBands branch above.
// ================================================================

function BandsCard({ title, aside, children, footer }: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div style={{ border: `1px solid ${B_LINE}`, borderRadius: 12, background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 16px 12px', borderBottom: `1px solid ${B_LINE}` }}>
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em' }}>{title}</span>
        {aside ?? <span style={{ fontSize: 12, color: B_GHOST }}>›</span>}
      </div>
      {children}
      {footer && (
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 16px', borderTop: `1px solid ${B_LINE}`, background: B_SURFACE }}>
          {footer}
        </div>
      )}
    </div>
  )
}

function BandsTile({ pair, children, size = 30 }: { pair: readonly [string, string]; children: React.ReactNode; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: size > 28 ? 9 : 8, flex: '0 0 auto', background: pair[0], color: pair[1] }}>
      {children}
    </span>
  )
}

function BandsTrail({ value, label, tone }: { value?: string; label: string; tone?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span aria-hidden style={{ width: 3, height: 3, borderRadius: '50%', background: B_GHOST, alignSelf: 'center', marginRight: 5 }} />
      {value && <span style={{ fontFamily: B_MONO, fontSize: 14, fontWeight: 600, color: tone ?? B_INK }}>{value}</span>}
      <span style={{ fontSize: 12, color: tone ?? B_MUTED }}>{label}</span>
    </span>
  )
}

function BandsSplit({ color, label, value, top }: { color: string; label: string; value: string; top: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: top }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: B_MUTED }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: color }} />
        {label}
      </span>
      <span style={{ fontFamily: B_MONO, fontSize: 12, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

function BandsLegend({ color, value, label, ink }: { color: string; value: string; label: string; ink: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: color, alignSelf: 'center' }} />
      <span style={{ fontFamily: B_MONO, fontSize: 12, fontWeight: 600, color: ink }}>{value}</span>
      <span style={{ fontSize: 11, color: B_MUTED }}>{label}</span>
    </span>
  )
}

const B_STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function BandsCardGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" {...B_STROKE} strokeWidth={1.6}>
      <rect x="1.5" y="4" width="17" height="12" rx="2.5" />
      <path d="M1.5 8h17" />
      <path d="M4.5 12.5h3" />
    </svg>
  )
}

function BandsCashGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" {...B_STROKE}>
      <ellipse cx="10" cy="5.3" rx="6.4" ry="2.5" />
      <path d="M3.6 5.3v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V5.3" />
      <path d="M3.6 9.7v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V9.7" />
    </svg>
  )
}

function BandsOutGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" {...B_STROKE}>
      <path d="M10 2.8l6.4 11H3.6l6.4-11z" />
      <path d="M10 7v2.8" />
      <circle cx="10" cy="11.6" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  )
}

function BandsLowGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" {...B_STROKE}>
      <circle cx="10" cy="10" r="6.2" />
      <path d="M10 6.4v3.8" />
      <circle cx="10" cy="13.3" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Area icon for Needs-doing rows — same lucide-shaped paths as
 *  the sidebar rail so the glyph names its destination. */
function BandsAreaGlyph({ area }: { area: 'STOCK' | 'MONEY' | 'MENU' | 'STAFF' }) {
  if (area === 'STOCK') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7.5 4.27 9 5.15" />
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
      </svg>
    )
  }
  if (area === 'MONEY') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="2" x2="12" y2="22" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    )
  }
  if (area === 'MENU') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8" />
        <path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7" />
        <path d="m2.1 21.8 6.4-6.3" />
        <path d="m19 5-7 7" />
      </svg>
    )
  }
  // STAFF — Users
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
