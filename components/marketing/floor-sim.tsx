'use client'

// ----------------------------------------------------------------
// FloorSim — scripted "ring it up" product demo for the marketing
// page. Plays itself once when it scrolls into view: a simulated
// finger taps a Taco, a Side, a Drink, then Continue, then Cash.
// Each tap surfaces as a small white touch dot (iPad-style touch
// indicator) — no moving cursor, no expanding ripple, no fanfare.
// The dot appears, the order line gets added, the next dot appears.
//
// After payment the inventory bars deplete visibly. The dishes
// pull enough stock that the bars move noticeably — that's the
// whole point of the simulation. No row flashes, no bar pulses.
// Just bars going down + numbers changing.
//
// After the script finishes a "Watch again" affordance appears and
// the demo becomes interactive — users who want to play can do so.
// ----------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'

const GREEN = '#16A34A'
const AMBER = '#B45309'
const RED = '#DC2626'

// Category KEYS stay stable across languages so all the bar math,
// state shape, and color maps keep working unchanged. The visible
// label is resolved per-lang via catLabel() below.
type Cat = 'Tacos' | 'Mariscos' | 'Sides' | 'Drinks'

interface MenuItem {
  id: string
  name: string
  price: number
  cat: Cat
  inv: Array<[string, number]>
}

// Recipe pulls are sized so a single ring puts a visible dent in the
// bars — each "tile" represents a typical plate-sized order, not a
// micro-portion. Restaurants buying a demo want to SEE the levers
// move; tiny depletion math defeats that.
//
// Two language-themed menus share the same internal item IDs + the
// same category keys so all downstream logic (recipe pulls, category
// totals, status pills) is identical. ES = Tacos Don Pork. EN = a
// burgers theme so the demo reads to American diners.
const MENU_ES: MenuItem[] = [
  { id: 'pastor',   name: 'Tacos al Pastor', price: 3.5,  cat: 'Tacos',    inv: [['pastor', 6], ['tortillas', 10]] },
  { id: 'asada',    name: 'Tacos de Asada',  price: 3.75, cat: 'Tacos',    inv: [['tortillas', 10]] },
  { id: 'birria',   name: 'Quesabirria',     price: 4.75, cat: 'Tacos',    inv: [['birria', 4], ['queso', 3], ['tortillas', 8]] },
  { id: 'pollo',    name: 'Tacos de Pollo',  price: 3.25, cat: 'Tacos',    inv: [['tortillas', 10]] },
  { id: 'ceviche',  name: 'Ceviche Tostada', price: 5.5,  cat: 'Mariscos', inv: [['limes', 5]] },
  { id: 'camaron',  name: 'Camarones',       price: 7.5,  cat: 'Mariscos', inv: [['limes', 4]] },
  { id: 'elote',    name: 'Elote',           price: 4.0,  cat: 'Sides',    inv: [['queso', 4]] },
  { id: 'guac',     name: 'Chips & Guac',    price: 5.0,  cat: 'Sides',    inv: [] },
  { id: 'horchata', name: 'Horchata',        price: 3.5,  cat: 'Drinks',   inv: [['horchata', 8]] },
  { id: 'jamaica',  name: 'Agua de Jamaica', price: 3.0,  cat: 'Drinks',   inv: [] },
]

// EN burger theme. Same category keys, same item IDs, same recipe
// math — only display names + prices shift. The "Tacos" category
// becomes Burgers, "Mariscos" becomes Sandwiches.
const MENU_EN: MenuItem[] = [
  { id: 'pastor',   name: 'Smash Burger',    price: 8.5,  cat: 'Tacos',    inv: [['pastor', 6], ['tortillas', 10]] },
  { id: 'asada',    name: 'Classic Cheese',  price: 8.75, cat: 'Tacos',    inv: [['tortillas', 10]] },
  { id: 'birria',   name: 'Bacon Stack',     price: 10.5, cat: 'Tacos',    inv: [['birria', 4], ['queso', 3], ['tortillas', 8]] },
  { id: 'pollo',    name: 'Crispy Chicken',  price: 9.0,  cat: 'Tacos',    inv: [['tortillas', 10]] },
  { id: 'ceviche',  name: 'Pulled Pork Sub', price: 9.5,  cat: 'Mariscos', inv: [['limes', 5]] },
  { id: 'camaron',  name: 'BLT Club',        price: 9.0,  cat: 'Mariscos', inv: [['limes', 4]] },
  { id: 'elote',    name: 'Loaded Fries',    price: 5.5,  cat: 'Sides',    inv: [['queso', 4]] },
  { id: 'guac',     name: 'Onion Rings',     price: 4.75, cat: 'Sides',    inv: [] },
  { id: 'horchata', name: 'Lemonade',        price: 3.5,  cat: 'Drinks',   inv: [['horchata', 8]] },
  { id: 'jamaica',  name: 'Iced Tea',        price: 3.0,  cat: 'Drinks',   inv: [] },
]

const TABS: Cat[] = ['Tacos', 'Mariscos', 'Sides', 'Drinks']

// ----------------------------------------------------------------
// Chapter 2 (Staffing → Finance) data. The simulation assigns Pork
// Adams from the bench into the MID-shift Server slot. Labor spend
// then ticks from $576 → $716 (a 7h shift at ~$20/h) and the spend
// bars rebalance in the Finance card next door.
// ----------------------------------------------------------------
type Role = 'Host' | 'Server'
interface BenchStaff { id: string; name: string; role: Role; color: string; hours: number }
const HOST_COLOR = '#167C54'
const SERVER_COLOR = '#7C5CFF'
// Bench mirrors the real Staffing screen: every staff member shows
// up in the roster with their weekly hours total in the top-right
// pill. Three of the four already appear in shift slots above (open1
// in OPEN, open2 in OPEN, mid1 in MID) — they're in both views
// because the bench is the full roster, not "available only."
// The 4th (id 'pork-adams') is the odd one out: he shows the
// "Unassigned" pill until the drag-and-drop schedules him.
//
// Per-language name sets share the same IDs + roles + colors so the
// drag-and-drop wiring + role styling never change with language.
const PORK_ADAMS_SHIFT_HOURS = 7    // MID 12p–7p
const PORK_ADAMS_WAGE = 11          // $/hour — labor calc anchor
const BENCH_FOH_EN: BenchStaff[] = [
  { id: 'john',       name: 'John Pork',    role: 'Host',   color: HOST_COLOR,   hours: 32 },
  { id: 'lepork',     name: 'LePork James', role: 'Server', color: SERVER_COLOR, hours: 28 },
  { id: 'charlie',    name: 'Charlie Pork', role: 'Host',   color: HOST_COLOR,   hours: 24 },
  { id: 'pork-adams', name: 'Pork Adams',   role: 'Server', color: SERVER_COLOR, hours: PORK_ADAMS_SHIFT_HOURS },
]
const BENCH_FOH_ES: BenchStaff[] = [
  { id: 'john',       name: 'Juanito Pork',       role: 'Host',   color: HOST_COLOR,   hours: 32 },
  { id: 'lepork',     name: 'Carlos Pork',        role: 'Server', color: SERVER_COLOR, hours: 28 },
  { id: 'charlie',    name: 'Guillermo del Pork', role: 'Host',   color: HOST_COLOR,   hours: 24 },
  { id: 'pork-adams', name: 'Eugenio DePork',     role: 'Server', color: SERVER_COLOR, hours: PORK_ADAMS_SHIFT_HOURS },
]
// Labor anchor reflects what a real owner could verify: starting at
// $499 (the 3 already-scheduled staff for the day), adding Pork
// Adams (7h × $11 = $77) lands at $576. The number changes are
// flagged "est." downstream so a sharp manager doesn't call BS.
const LABOR_BEFORE = 499
const LABOR_AFTER = LABOR_BEFORE + PORK_ADAMS_SHIFT_HOURS * PORK_ADAMS_WAGE  // 576
const INVENTORY_SPEND = 642.50
const OPERATING_SPEND = 180

const SALES_SEED = 1842.5
const ORDERS_SEED = 53
const CASH_SEED = 31
const CARD_SEED = 19
const OTHER_SEED = 3
const CAT_SEED: Record<Cat, number> = { Tacos: 902, Mariscos: 404, Sides: 288, Drinks: 248 }
const DAILY_SEED = [2100, 1850, 2320, 1980, 2640, 3100, 2890, 2010, 1760, 2450, 2980, 3210, 2740]

// Chapter 3 time-lapse mixes — used to animate the category and
// payment bars across the day. The morning shapes are intentionally
// extreme so the rebalance over the day is dramatic, not subtle:
// at open, breakfast tacos near-totally dominate (88%) and the
// other categories are barely visible slivers; by close, mariscos
// (+19 pts), sides (+10), and drinks (+10) have all clearly emerged.
// Same idea on payment: morning is almost entirely cash (Cash 86 /
// Card 11), swinging hard toward the standard mix by close.
const MORNING_CAT_MIX: Record<Cat, number>   = { Tacos: 88, Mariscos: 3, Sides: 6, Drinks: 3 }
const MORNING_PAYMENT_MIX = { card: 11, cash: 86, other: 3 }

// Per-category bar shades. Brand identity is monochrome — status
// colors (green/amber/red) are reserved for OK/Low/Out indicators
// and shouldn't bleed into category encoding. Instead we use a
// slate ladder, darkest → lightest, in rough order of typical share.
// Bars stay readable, the labels do the identification work, and
// the chart slots into the rest of the site's grayscale palette
// without competing with the receipt motif or the dark CTA section.
const CAT_COLOR: Record<Cat, string> = {
  Tacos:    '#18181B', // ink
  Mariscos: '#3F3F46', // dark slate
  Sides:    '#71717A', // mid slate
  Drinks:   '#A1A1A6', // light slate
}

interface InvItem { name: string; u: number; cap: number; reorder: number }
interface OrderLine { id: string; name: string; price: number; qty: number }

const fmt = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Starting values + declaration order are tuned together so the
// inventory rail tells a coherent story across the demo.
//
//   Initial sort (stable, by status urgency Out→Low→OK):
//     1. Limes        7  cap 60  reorder 14  → LOW   (was already low)
//     2. Horchata mix 8  cap 20  reorder 10  → LOW   (visible from the start,
//                                                     so going OUT later
//                                                     reads as a progression,
//                                                     not a pop-in)
//     3. Pastor       16 cap 40  reorder 10  → OK
//     4. Tortillas    88 cap 130 reorder 40  → OK    (deep buffer; stays OK)
//     5. Queso        11 cap 30  reorder 7   → OK
//     6. Birria       13 cap 25  reorder 8   → OK    (not touched by demo)
//
//   After the demo ticket pays (pulls pastor 6, tortillas 10, queso 4,
//   horchata 8) the status borders an owner's eye catches:
//     horchata  8 → 0  LOW → OUT   (the dramatic one)
//     pastor   16 → 10 OK  → LOW
//     queso    11 →  7 OK  → LOW
//     tortillas 88 → 78 OK → OK    (still well clear of reorder)
// Per-language inventory display names. Same keys + same numbers
// so all the math (status thresholds, depletion deltas, sort order)
// is identical across languages — only the human-readable label
// changes.
function initialInvES(): Record<string, InvItem> {
  return {
    limes:     { name: 'Limes',              u: 7,  cap: 60,  reorder: 14 },
    horchata:  { name: 'Horchata mix',       u: 8,  cap: 20,  reorder: 10 },
    pastor:    { name: 'Pastor (marinated)', u: 16, cap: 40,  reorder: 10 },
    tortillas: { name: 'Tortillas',          u: 88, cap: 130, reorder: 40 },
    queso:     { name: 'Queso Oaxaca',       u: 11, cap: 30,  reorder: 7 },
    birria:    { name: 'Birria',             u: 13, cap: 25,  reorder: 8 },
  }
}
function initialInvEN(): Record<string, InvItem> {
  return {
    limes:     { name: 'Lemons',         u: 7,  cap: 60,  reorder: 14 },
    horchata:  { name: 'Lemonade mix',   u: 8,  cap: 20,  reorder: 10 },
    pastor:    { name: 'Beef patties',   u: 16, cap: 40,  reorder: 10 },
    tortillas: { name: 'Brioche buns',   u: 88, cap: 130, reorder: 40 },
    queso:     { name: 'Cheddar slices', u: 11, cap: 30,  reorder: 7 },
    birria:    { name: 'Bacon',          u: 13, cap: 25,  reorder: 8 },
  }
}

// ----------------------------------------------------------------
// Demo script — choreographed taps. Timings are ms from startScript().
// No cursor pre-glide — touch dots just appear at the tap moment.
// ----------------------------------------------------------------
type ScriptStep =
  | { type: 'tab'; cat: Cat }
  | { type: 'tap'; itemId: string }
  | { type: 'continue' }
  | { type: 'pay'; method: 'Cash' | 'Card' }

// Pacing tuned to feel like a real cashier ringing up a 3-item order:
// a small beat to orient on the first tap, ~900ms between actions
// that require a tab-switch (eye relocates), ~700ms between actions
// in the same context, and a longer beat before Continue + before
// Cash where a real person pauses to confirm or pick.
const SCRIPT: { at: number; step: ScriptStep }[] = [
  { at: 800,  step: { type: 'tap', itemId: 'pastor' } },     // First tap — eye finds tile, finger arrives
  { at: 1750, step: { type: 'tab', cat: 'Sides' } },          // Switch to Sides (think about next item)
  { at: 2450, step: { type: 'tap', itemId: 'elote' } },       // Elote (found it in the new tab)
  { at: 3400, step: { type: 'tab', cat: 'Drinks' } },         // Switch to Drinks
  { at: 4100, step: { type: 'tap', itemId: 'horchata' } },    // Horchata
  { at: 5200, step: { type: 'continue' } },                   // Continue (longer beat — eye scans the order)
  { at: 6150, step: { type: 'pay', method: 'Cash' } },        // Cash (slight pause to choose payment)
]
// Buffer accounts for the staggered pay sequence: the last step
// (pay) holds the check 1500ms, fades 350ms, then bars run their
// 850ms drop transition. Total settle time from pay → ~2700ms.
// We add a tail beat so the demo doesn't unlock click handlers
// while the bars are still in motion.
const SCRIPT_END_BUFFER = 3100

type Lang = 'en' | 'es'

interface FloorSimProps {
  lang?: Lang
}

export default function FloorSim({ lang = 'en' }: FloorSimProps) {
  // Inline translation helper. ES wins when lang === 'es' AND the
  // Spanish string is non-empty; otherwise EN is used as fallback.
  const t = (en: string, es?: string): string => (lang === 'es' && es ? es : en)
  // Resolve menu, inventory factory, bench staff, and business name
  // from lang. Same item IDs + same numbers across both — only the
  // labels swap.
  const MENU = lang === 'es' ? MENU_ES : MENU_EN
  const initialInv = lang === 'es' ? initialInvES : initialInvEN
  const BENCH_FOH = lang === 'es' ? BENCH_FOH_ES : BENCH_FOH_EN
  const BIZ_NAME = lang === 'es' ? 'TACOS DON PORK' : 'PORK’S BURGERS'
  // Category display label — keys stay stable internally, label
  // resolves per lang.
  const catLabel = (c: Cat): string => {
    if (lang === 'es') {
      if (c === 'Sides') return 'Extras'
      if (c === 'Drinks') return 'Bebidas'
      return c
    }
    if (c === 'Tacos') return 'Burgers'
    if (c === 'Mariscos') return 'Sandwiches'
    return c
  }
  // Open-shift + mid-shift staff names. Stay aligned with the BENCH
  // ordering so the same person who shows up in the schedule also
  // appears in the bench list.
  const STAFF = lang === 'es'
    ? { openHost: 'Juanito Pork', openServer: 'Carlos Pork', midHost: 'Guillermo del Pork', midServer: 'Eugenio DePork' }
    : { openHost: 'John Pork',    openServer: 'LePork James', midHost: 'Charlie Pork',     midServer: 'Pork Adams' }

  const [tab, setTab] = useState<Cat>('Tacos')
  const [order, setOrder] = useState<OrderLine[]>([])
  const [checkout, setCheckout] = useState(false)
  const [salesPaid, setSalesPaid] = useState(0)
  const [ordersPaid, setOrdersPaid] = useState(0)
  const [cashPaid, setCashPaid] = useState(0)
  const [cardPaid, setCardPaid] = useState(0)
  const [catLive, setCatLive] = useState<Record<Cat, number>>({ Tacos: 0, Mariscos: 0, Sides: 0, Drinks: 0 })
  const [inv, setInv] = useState<Record<string, InvItem>>(initialInv)
  const [paid, setPaid] = useState<string | null>(null)
  // Drives the smooth fade-out of the "Paid" overlay. Separate from
  // `paid` so the element stays mounted while opacity transitions.
  const [paidFading, setPaidFading] = useState(false)
  const [ticket, setTicket] = useState(6041)
  const [mounted, setMounted] = useState(false)

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false)
  const [hasPlayed, setHasPlayed] = useState(false)
  const [touches, setTouches] = useState<{ id: number; x: number; y: number }[]>([])

  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const touchIdRef = useRef(0)

  // Chapter 2 (Staffing → Finance) playback state.
  // dragState walks the Pork Adams card through a drag-and-drop:
  //   idle  → bench has all 4, MID server slot empty
  //   lift  → touch dot lands on Pork Adams, card scales up + shadow
  //   drag  → card translates from bench → empty slot over 850ms
  //   land  → card arrives, scale settles back to 1
  //   done  → bench card hidden, shift slot filled statically
  const [c2HasPlayed, setC2HasPlayed] = useState(false)
  const [c2Playing, setC2Playing] = useState(false)
  const [dragState, setDragState] = useState<'idle' | 'lift' | 'drag' | 'land' | 'done'>('idle')
  const [dragDelta, setDragDelta] = useState({ x: 0, y: 0 })
  const [shiftFilled, setShiftFilled] = useState(false)
  const [c2Confirm, setC2Confirm] = useState(false)
  const [c2ConfirmFading, setC2ConfirmFading] = useState(false)
  const [laborSpend, setLaborSpend] = useState(LABOR_BEFORE)
  // Highlight pulse on the Scheduled labor row the moment the
  // labor number ticks up — gives the demo viewer an obvious
  // "the shift assignment moved the money" cue. See Chapter 2
  // script step at 4100ms.
  const [laborPulse, setLaborPulse] = useState(false)
  const [c2Touches, setC2Touches] = useState<{ id: number; x: number; y: number }[]>([])
  const c2TouchIdRef = useRef(0)
  // Persistent touch dot that rides along with the dragged Pork
  // Adams card. Set at the lift moment (with the same jitter as
  // any other touch) and translates with the same dragDelta as
  // the card so they move as one.
  const [dragTouchPos, setDragTouchPos] = useState<{ x: number; y: number } | null>(null)

  // Chapter 3 (Analytics) playback state.
  //   c3LastBarScale  multiplies the last (today) bar's height
  //                    during the time-lapse — 0.25 morning → 1.0
  //                    close. Other bars stay at their full
  //                    historical height.
  //   c3BarsAnimate   gates the CSS height transition. We disable
  //                    it for the initial morning reset (so the
  //                    bar doesn't visibly shrink), then re-enable
  //                    for the growth animation.
  //   c3TimeLabel     the small mono ticker beneath the chart.
  //   c3Closed        controls the brief "Closed · 11:43 PM"
  //                    timestamp overlay (mirrors the POS Paid
  //                    overlay's pop + fade).
  //   c3Touches       transient tap that lands on today's bar
  //                    just before the insight panel reveals.
  //   c3Insight       drives the slide-up insight panel.
  const [c3Playing, setC3Playing] = useState(false)
  const [c3HasPlayed, setC3HasPlayed] = useState(false)
  const [c3LastBarScale, setC3LastBarScale] = useState(1)
  const [c3BarsAnimate, setC3BarsAnimate] = useState(true)
  // c3GlobalScale multiplies EVERY bar's height (today's + the 13
  // historical bars). At sim start we drop it to 0 with transitions
  // off, then enable transitions and animate back to 1 with a
  // staggered transition-delay per bar — the whole chart visibly
  // "wakes up" left-to-right instead of being static while only
  // today's bar grows during the later time-lapse.
  const [c3GlobalScale, setC3GlobalScale] = useState(1)
  const [c3InSweep, setC3InSweep] = useState(false)
  const [c3TimeLabel, setC3TimeLabel] = useState('')
  const [c3Closed, setC3Closed] = useState(false)
  const [c3ClosedFading, setC3ClosedFading] = useState(false)
  const [c3Touches, setC3Touches] = useState<{ id: number; x: number; y: number }[]>([])
  const c3TouchIdRef = useRef(0)
  const [c3Insight, setC3Insight] = useState(false)
  const [c3InsightFading, setC3InsightFading] = useState(false)

  // Refs to elements the script targets. Each tab button + each
  // currently-rendered menu tile + the payment buttons register
  // here so getRelPos() can convert their bounding rect into a
  // coordinate inside the POS card.
  const posCardRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const continueRef = useRef<HTMLButtonElement | null>(null)
  const cashRef = useRef<HTMLButtonElement | null>(null)
  const cardBtnRef = useRef<HTMLButtonElement | null>(null)

  // Chapter 2 refs — the staffing card (touch-dot container) plus
  // the bench items + empty MID-slot the drag travels between.
  const staffCardRef = useRef<HTMLDivElement | null>(null)
  const benchItemRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const emptyShiftSlotRef = useRef<HTMLSpanElement | null>(null)

  // Chapter 3 refs — the analytics card (touch container) and the
  // today bar's wrapper (target for the tap that triggers insights).
  const analyticsCardRef = useRef<HTMLDivElement | null>(null)
  const todayBarRef = useRef<HTMLDivElement | null>(null)

  // Latest-state refs — let scheduled timeouts read the freshest
  // order / inv even though their closures were captured earlier.
  const orderRef = useRef<OrderLine[]>([])
  const invRef = useRef<Record<string, InvItem>>(initialInv())
  useEffect(() => { orderRef.current = order }, [order])
  useEffect(() => { invRef.current = inv }, [inv])

  // Convert a target element's bounding rect into a position
  // relative to the POS card's top-left. Touch dots render
  // absolutely inside the POS card. Small jitter is added so the
  // taps don't land robotically dead-center — a real finger hits
  // somewhere around the middle, not exactly on it. Jitter is
  // proportional to element size so small targets (tab buttons)
  // get smaller offsets than larger ones (menu tiles).
  const getRelPos = (el: HTMLElement | null) => {
    if (!el || !posCardRef.current) return null
    const er = el.getBoundingClientRect()
    const pr = posCardRef.current.getBoundingClientRect()
    // Jitter scales with the target so larger tiles feel naturally
    // off-center while small tab buttons still get tapped inside.
    // Tiles (~140×60) → up to ±31×±15. Tabs (~60×28) → up to ±13×±7.
    const jx = (Math.random() - 0.5) * er.width * 0.45
    const jy = (Math.random() - 0.5) * er.height * 0.50
    return {
      x: er.left - pr.left + er.width / 2 + jx,
      y: er.top - pr.top + er.height / 2 + jy,
    }
  }

  const addItem = (m: MenuItem) => {
    setOrder((prev) => {
      const next = prev.map((o) => ({ ...o }))
      const ex = next.find((o) => o.id === m.id)
      if (ex) ex.qty += 1
      else next.push({ id: m.id, name: m.name, price: m.price, qty: 1 })
      return next
    })
    setCheckout(false)
  }

  const removeLine = (i: number) => { setOrder((p) => p.filter((_, idx) => idx !== i)); setCheckout(false) }
  const clearOrder = () => { setOrder([]); setCheckout(false) }
  const continueToPayment = () => { if (orderRef.current.length) setCheckout(true) }

  // Read order + inv from refs so this works whether called from a
  // fresh click or from a setTimeout scheduled earlier.
  //
  // Pay is choreographed in three beats so neither the green check
  // nor the inventory drop competes for attention:
  //   0ms     Check pops in. Money side updates (revenue, payment
  //           mix, category mix, ticket #).
  //   1500ms  Check starts a 350ms fade-out.
  //   1850ms  Check fully gone → INVENTORY BARS start dropping
  //           (their own 850ms transition runs underneath).
  //   2700ms  Bars settle. Demo can move on.
  // The eye finishes with the receipt-style check, then naturally
  // moves to the inventory rail just as it begins to shrink.
  const pay = (method: string) => {
    const currentOrder = orderRef.current
    const currentInv = invRef.current
    const total = currentOrder.reduce((a, o) => a + o.price * o.qty, 0)
    const nextInv: Record<string, InvItem> = JSON.parse(JSON.stringify(currentInv))
    const nextCatDelta: Record<Cat, number> = { Tacos: 0, Mariscos: 0, Sides: 0, Drinks: 0 }
    currentOrder.forEach((o) => {
      const m = MENU.find((x) => x.id === o.id)!
      nextCatDelta[m.cat] += o.price * o.qty
      m.inv.forEach(([k, n]) => {
        if (nextInv[k]) nextInv[k].u = Math.max(0, nextInv[k].u - n * o.qty)
      })
    })
    // Immediate: money side + clear order + show paid overlay.
    setOrder([]); setCheckout(false)
    setSalesPaid((v) => v + total)
    setOrdersPaid((v) => v + 1)
    if (method === 'Cash') setCashPaid((v) => v + 1)
    if (method === 'Card') setCardPaid((v) => v + 1)
    setCatLive((prev) => ({
      Tacos: prev.Tacos + nextCatDelta.Tacos,
      Mariscos: prev.Mariscos + nextCatDelta.Mariscos,
      Sides: prev.Sides + nextCatDelta.Sides,
      Drinks: prev.Drinks + nextCatDelta.Drinks,
    }))
    setPaid(method); setPaidFading(false); setTicket((v) => v + 1)
    // 1500ms in: kick off the check overlay's fade-out.
    timers.current.push(setTimeout(() => setPaidFading(true), 1500))
    // 1850ms in: overlay is fully transparent → unmount it AND
    // start the inventory drop on the same tick. Bars animate
    // their 850ms transition into the now-visible card.
    timers.current.push(setTimeout(() => {
      setPaid(null)
      setPaidFading(false)
      setInv(nextInv)
    }, 1850))
  }

  // ----------------------------------------------------------------
  // Script execution
  // ----------------------------------------------------------------
  const getStepRef = (step: ScriptStep): HTMLElement | null => {
    switch (step.type) {
      case 'tab': return tabRefs.current[step.cat]
      case 'tap': return tileRefs.current[step.itemId]
      case 'continue': return continueRef.current
      case 'pay': return step.method === 'Cash' ? cashRef.current : cardBtnRef.current
    }
  }

  const executeStep = (step: ScriptStep) => {
    // Drop a small white touch dot at the target's center.
    const el = getStepRef(step)
    const pos = getRelPos(el)
    if (pos) {
      const id = ++touchIdRef.current
      setTouches((t) => [...t, { id, x: pos.x, y: pos.y }])
      timers.current.push(setTimeout(() => {
        setTouches((t) => t.filter((tt) => tt.id !== id))
      }, 700))
    }
    // Then trigger the state change.
    switch (step.type) {
      case 'tab':
        setTab(step.cat)
        break
      case 'tap': {
        const item = MENU.find((m) => m.id === step.itemId)
        if (item) addItem(item)
        break
      }
      case 'continue':
        continueToPayment()
        break
      case 'pay':
        pay(step.method)
        break
    }
  }

  const startScript = () => {
    if (isPlaying) return
    setIsPlaying(true)
    setHasPlayed(true)
    // Clean reset before playing (handles re-runs from "Watch again")
    setOrder([])
    setCheckout(false)
    setInv(initialInv())
    setSalesPaid(0)
    setOrdersPaid(0)
    setCashPaid(0)
    setCardPaid(0)
    setCatLive({ Tacos: 0, Mariscos: 0, Sides: 0, Drinks: 0 })
    setTab('Tacos')
    setPaid(null)
    setTouches([])

    // Schedule each step at its time. No cursor pre-glide.
    SCRIPT.forEach(({ at, step }) => {
      timers.current.push(setTimeout(() => executeStep(step), at))
    })

    // After the last step (pay) finishes settling, mark playback
    // complete so the "Watch again" affordance can appear and the
    // demo is interactive for the user.
    const endAt = SCRIPT[SCRIPT.length - 1].at + SCRIPT_END_BUFFER
    timers.current.push(setTimeout(() => {
      setIsPlaying(false)
    }, endAt))
  }

  // Mount + IntersectionObserver — start the script when the
  // POS card is 30%+ visible, once per page load. Earlier this
  // observed the OUTER FloorSim container, but on phone (where
  // all three chapters stack vertically) the container is ~3000px
  // tall against a ~700px viewport, so max intersection ratio
  // could never exceed ~0.23 and the script never fired. Targeting
  // the POS card (which is what carries Chapter 1's visual anyway)
  // matches the per-chapter pattern Chapters 2 and 3 already use
  // and lets the threshold work on any screen size.
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    timers.current = []
    timers.current.push(setTimeout(() => setMounted(true), 80))
    const node = posCardRef.current
    if (!node) return () => { timers.current.forEach(clearTimeout) }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.3 && !hasPlayed) {
            startScript()
            break
          }
        }
      },
      { threshold: [0.3] },
    )
    observer.observe(node)
    return () => {
      timers.current.forEach(clearTimeout)
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----------------------------------------------------------------
  // Chapter 2 simulation — drag Pork Adams from the bench into the
  // empty MID-shift Server slot. Reuses the POS touch-dot effect
  // and the same staggered confirmation → fade → result-update
  // cadence (1500ms hold, 350ms fade, then the labor amount ticks).
  // ----------------------------------------------------------------
  const getC2RelPos = (el: HTMLElement | null) => {
    if (!el || !staffCardRef.current) return null
    const er = el.getBoundingClientRect()
    const sr = staffCardRef.current.getBoundingClientRect()
    const jx = (Math.random() - 0.5) * er.width * 0.45
    const jy = (Math.random() - 0.5) * er.height * 0.50
    return {
      x: er.left - sr.left + er.width / 2 + jx,
      y: er.top - sr.top + er.height / 2 + jy,
    }
  }

  const spawnC2Touch = (el: HTMLElement | null) => {
    const pos = getC2RelPos(el)
    if (!pos) return
    const id = ++c2TouchIdRef.current
    setC2Touches((t) => [...t, { id, x: pos.x, y: pos.y }])
    timers.current.push(setTimeout(() => {
      setC2Touches((t) => t.filter((tt) => tt.id !== id))
    }, 700))
  }

  // Measure the translate vector that takes the bench Pork Adams
  // card from its layout position to the center of the empty slot.
  const computeDragDelta = () => {
    const source = benchItemRefs.current['pork-adams']
    const target = emptyShiftSlotRef.current
    if (!source || !target) return { x: 0, y: 0 }
    const sr = source.getBoundingClientRect()
    const tr = target.getBoundingClientRect()
    return {
      x: tr.left + tr.width / 2 - sr.left - sr.width / 2,
      y: tr.top + tr.height / 2 - sr.top - sr.height / 2,
    }
  }

  const startC2Script = () => {
    if (c2Playing) return
    setC2Playing(true)
    setC2HasPlayed(true)
    // Fresh reset (covers replay scenarios).
    setDragState('idle')
    setDragDelta({ x: 0, y: 0 })
    setShiftFilled(false)
    setC2Confirm(false)
    setC2ConfirmFading(false)
    setLaborSpend(LABOR_BEFORE)
    setLaborPulse(false)
    setC2Touches([])
    setDragTouchPos(null)

    // 700ms: touch lands on Pork Adams, card lifts (scale + shadow).
    // The touch dot is set here at a jittered position and persists
    // through the drag — it rides along with the card via dragDelta.
    timers.current.push(setTimeout(() => {
      setDragState('lift')
      const pos = getC2RelPos(benchItemRefs.current['pork-adams'])
      if (pos) setDragTouchPos(pos)
    }, 700))
    // 1100ms: measure the path and start the 850ms drag
    timers.current.push(setTimeout(() => {
      setDragDelta(computeDragDelta())
      setDragState('drag')
    }, 1100))
    // 1950ms: card arrives, scale settles back
    timers.current.push(setTimeout(() => setDragState('land'), 1950))
    // 2250ms: drop completes → Pork Adams locks into shift slot,
    //         bench card hides, "Shift assigned" overlay pops in
    timers.current.push(setTimeout(() => {
      setShiftFilled(true)
      setDragState('done')
      setC2Confirm(true)
    }, 2250))
    // 3750ms: overlay starts its 350ms fade-out (matches POS)
    timers.current.push(setTimeout(() => setC2ConfirmFading(true), 3750))
    // 4100ms: overlay gone → labor amount ticks up. The Finance
    //         spend bars run their 850ms width transition into
    //         the now-visible card. Same beat structure as the
    //         POS pay → inventory drop.
    timers.current.push(setTimeout(() => {
      setC2Confirm(false)
      setC2ConfirmFading(false)
      setLaborSpend(LABOR_AFTER)
      // Kick off the "money moved" pulse: glow on the Scheduled
      // labor row + a floating "+$77.00" delta + a brief bar
      // brightness flash. The duration matches the bar-width
      // transition (850ms) plus a settle tail so the eye sees
      // the cause-and-effect clearly.
      setLaborPulse(true)
    }, 4100))
    timers.current.push(setTimeout(() => setLaborPulse(false), 6000))
    // 5800ms: settle, demo finished
    timers.current.push(setTimeout(() => setC2Playing(false), 5800))
  }

  useEffect(() => {
    const node = staffCardRef.current
    if (!node) return
    // Threshold 0.5 (not 0.3) because the Staffing card is small
    // (~400px) relative to a typical viewport. At 0.3 the sim fires
    // when only ~120px is visible — usually while the visitor is
    // still scrolling past Chapter 1 and not yet focused on Chapter 2.
    // 0.5 gates the trigger until they're actually looking at it.
    //
    // We INTENTIONALLY do NOT call observer.disconnect() on fire,
    // and we INTENTIONALLY let the stale closure for c2HasPlayed
    // act as a no-op. Combined, this means: every time the staffing
    // card re-enters the viewport at ≥50% visibility, the script
    // replays from the top. That matches the loop behavior on
    // Chapter 1 (POS) — the visitor can scroll back to any chapter
    // and watch the simulation again without a hard reload.
    //
    // `startC2Script` resets all internal state at the top (drag
    // state, shift filled, confirm/fade flags, labor spend, touch
    // dots), so re-firing is safe and visually clean.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.5) {
            startC2Script()
            break
          }
        }
      },
      { threshold: [0.5] },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----------------------------------------------------------------
  // Chapter 3 simulation — analytics time-lapse + insight reveal.
  // The day replays in front of the visitor: today's bar grows from
  // a morning level up to its closing height while a tiny time
  // ticker counts beneath the chart. At the end the time stamp
  // settles to "Closed · 11:43 PM", a tap lands on today's bar, and
  // an insight panel pops up over the chart with the day's takeaway.
  // Same touch-dot styling + tap timing as the POS chapter, same
  // 3-beat shape (action → confirm → result) as Staffing.
  // ----------------------------------------------------------------
  const getC3RelPos = (el: HTMLElement | null) => {
    if (!el || !analyticsCardRef.current) return null
    const er = el.getBoundingClientRect()
    const ar = analyticsCardRef.current.getBoundingClientRect()
    const jx = (Math.random() - 0.5) * er.width * 0.45
    const jy = (Math.random() - 0.5) * er.height * 0.50
    return {
      x: er.left - ar.left + er.width / 2 + jx,
      y: er.top - ar.top + er.height / 2 + jy,
    }
  }

  const spawnC3Touch = (el: HTMLElement | null) => {
    const pos = getC3RelPos(el)
    if (!pos) return
    const id = ++c3TouchIdRef.current
    setC3Touches((t) => [...t, { id, x: pos.x, y: pos.y }])
    timers.current.push(setTimeout(() => {
      setC3Touches((t) => t.filter((tt) => tt.id !== id))
    }, 700))
  }

  const startC3Script = () => {
    if (c3Playing) return
    setC3Playing(true)
    setC3HasPlayed(true)
    setC3Closed(false)
    setC3ClosedFading(false)
    setC3Insight(false)
    setC3InsightFading(false)
    setC3Touches([])

    // Beat 0 — instant reset: ALL bars to 0 height (sweep target)
    // and today's time-lapse multiplier pre-set to morning. With
    // animations disabled this happens in a single frame so the
    // visitor never sees the existing bars shrink.
    setC3BarsAnimate(false)
    setC3GlobalScale(0)
    setC3LastBarScale(0.22)
    setC3TimeLabel('11:00 AM')

    // Beat 1 — enable transitions, switch into sweep mode (each
    // bar gets a transition-delay = i × 45ms), and push the global
    // scale to 1. The whole chart rises left-to-right over ~1s,
    // with today's bar landing at its morning height (b.h × 0.22).
    timers.current.push(setTimeout(() => {
      setC3BarsAnimate(true)
      setC3InSweep(true)
      setC3GlobalScale(1)
    }, 120))
    // End sweep mode — subsequent transition-delays revert to 0 so
    // the time-lapse milestones fire immediately on today's bar.
    timers.current.push(setTimeout(() => setC3InSweep(false), 1100))

    // Beat 2 — time-lapse: today's bar grows through the day.
    // Faster around lunch + dinner rushes, slower in the afternoon
    // lull. While this plays, the category and payment mix bars
    // blend from MORNING_* shapes toward standard via c3Blend.
    timers.current.push(setTimeout(() => { setC3LastBarScale(0.38); setC3TimeLabel('12:30 PM') }, 1400))
    timers.current.push(setTimeout(() => { setC3LastBarScale(0.60); setC3TimeLabel('2:00 PM')  }, 2300))
    timers.current.push(setTimeout(() => { setC3LastBarScale(0.70); setC3TimeLabel('4:30 PM')  }, 3300))
    timers.current.push(setTimeout(() => { setC3LastBarScale(0.84); setC3TimeLabel('6:30 PM')  }, 4300))
    timers.current.push(setTimeout(() => { setC3LastBarScale(0.95); setC3TimeLabel('9:00 PM')  }, 5200))
    timers.current.push(setTimeout(() => { setC3LastBarScale(1.00); setC3TimeLabel('11:43 PM') }, 6000))

    // Beat 3 — close (green check + label in the ticker row).
    timers.current.push(setTimeout(() => setC3Closed(true), 6500))

    // Beat 4 — tap lands on today's bar, then insight panel pops
    // up ~250ms later so the cause-effect reads clearly.
    timers.current.push(setTimeout(() => spawnC3Touch(todayBarRef.current), 7900))
    timers.current.push(setTimeout(() => setC3Insight(true), 8150))

    // Settle.
    timers.current.push(setTimeout(() => setC3Playing(false), 9800))
  }

  useEffect(() => {
    const node = analyticsCardRef.current
    if (!node) return
    // Same 0.5 threshold as Chapter 2 (and same rationale: the
    // analytics card is small relative to the viewport — at 0.3
    // the sim fires while the visitor is still scrolling past
    // Chapter 2, so by the time they focus on it the day has
    // already advanced). 0.5 holds until they're actually on it.
    //
    // Same replay-on-re-entry pattern as Chapter 2: NO disconnect,
    // and the stale-closure no-op intentionally allows the script
    // to re-fire every time the analytics card re-enters the
    // viewport. `startC3Script` resets all internal state at the
    // top, so re-firing replays the time-lapse cleanly.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.5) {
            startC3Script()
            break
          }
        }
      },
      { threshold: [0.5] },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- derived values ----
  const stockFor = (m: MenuItem): 'OK' | 'Low' | 'Out' => {
    let worst: 'OK' | 'Low' | 'Out' = 'OK'
    m.inv.forEach(([k]) => {
      const it = inv[k]; if (!it) return
      const st = it.u <= 0 ? 'Out' : it.u <= it.reorder ? 'Low' : 'OK'
      if (st === 'Out') worst = 'Out'
      else if (st === 'Low' && worst !== 'Out') worst = 'Low'
    })
    return worst
  }
  const stockColor: Record<string, string> = { OK: '#9CA3AF', Low: AMBER, Out: RED }
  const stockLabelI18n: Record<string, string> = lang === 'es'
    ? { OK: '', Low: 'BAJO', Out: 'AGOTADO' }
    : { OK: '', Low: 'Low', Out: 'Out' }
  const tiles = MENU.filter((m) => m.cat === tab).map((m) => {
    const st = stockFor(m)
    return { item: m, name: m.name, priceStr: fmt(m.price), stockLabel: stockLabelI18n[st], stockColor: stockColor[st] }
  })
  const total = order.reduce((a, o) => a + o.price * o.qty, 0)
  const sales = SALES_SEED + salesPaid
  void (ORDERS_SEED + ordersPaid)

  const rank: Record<string, number> = { Out: 0, Low: 1, OK: 2 }
  const statusLabelI18n: Record<string, string> = lang === 'es'
    ? { OK: 'OK', Low: 'BAJO', Out: 'AGOTADO' }
    : { OK: 'OK', Low: 'LOW', Out: 'OUT' }
  const invRows = Object.entries(inv).map(([k, it]) => {
    const st = it.u <= 0 ? 'Out' : it.u <= it.reorder ? 'Low' : 'OK'
    const color = st === 'Out' ? RED : st === 'Low' ? AMBER : GREEN
    const pillBg = st === 'Out' ? '#FCECEC' : st === 'Low' ? '#FBF1E3' : '#ECF6EF'
    return {
      key: k, name: it.name, valStr: it.u.toFixed(2), valColor: color, statusLabel: statusLabelI18n[st],
      statusColor: color, pillBg, pct: mounted ? Math.max(3, Math.min(100, Math.round((it.u / it.cap) * 100))) : 0, r: rank[st],
    }
  }).sort((a, b) => a.r - b.r)

  const rawDaily = [...DAILY_SEED, sales]
  const maxDaily = Math.max(...rawDaily)
  const dailyBars = rawDaily.map((v, i) => ({
    h: mounted ? Math.max(4, Math.round((v / maxDaily) * 100)) : 0,
    color: i === rawDaily.length - 1 ? '#2563EB' : '#C9D2DE',
  }))

  const catTotal = TABS.reduce((a, c) => a + CAT_SEED[c] + catLive[c], 0)
  // Evening = current/standard percentages. The Chapter 3 sim
  // blends MORNING_CAT_MIX toward these using c3LastBarScale, so
  // before the sim plays the chart shows the standard values, and
  // when the sim ends (scale=1) the values land back at the same
  // standard. The bars themselves carry a 0.55s width transition
  // so each blend step smoothly slides into the next milestone.
  const c3Blend = c3HasPlayed ? Math.min(1, Math.max(0, c3LastBarScale)) : 1
  const catBars = TABS.map((c) => {
    const v = CAT_SEED[c] + catLive[c]
    const eveningPct = Math.round((v / catTotal) * 100)
    const morningPct = MORNING_CAT_MIX[c]
    const pct = Math.round(morningPct * (1 - c3Blend) + eveningPct * c3Blend)
    return { name: catLabel(c), pct: mounted ? pct : 0, pctStr: pct + '%', color: CAT_COLOR[c] }
  })

  const cash = CASH_SEED + cashPaid, card = CARD_SEED + cardPaid, other = OTHER_SEED
  const ptot = cash + card + other
  const evCardPct = Math.round((card / ptot) * 100)
  const evCashPct = Math.round((cash / ptot) * 100)
  const cardPct = Math.round(MORNING_PAYMENT_MIX.card * (1 - c3Blend) + evCardPct * c3Blend)
  const cashPct = Math.round(MORNING_PAYMENT_MIX.cash * (1 - c3Blend) + evCashPct * c3Blend)
  const otherPct = Math.max(0, 100 - cardPct - cashPct)

  // Spend is derived live from labor (which ticks when Chapter 2's
  // script assigns Pork Adams). Inventory + operating are constant
  // — they're real, audited spend. Labor is the only line that
  // moves, and it's flagged as an estimate downstream.
  const totalSpend = laborSpend + INVENTORY_SPEND + OPERATING_SPEND
  const laborPct = Math.round((laborSpend / totalSpend) * 100)
  const inventoryPct = Math.round((INVENTORY_SPEND / totalSpend) * 100)
  const operatingPct = Math.max(0, 100 - laborPct - inventoryPct)
  const net = sales - totalSpend
  const netStr = (net >= 0 ? '+' : '−') + fmt(Math.abs(net))
  const netColor = net >= 0 ? GREEN : RED

  // ---- small style helpers ----
  const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
  const chapterNum: CSSProperties = {
    flexShrink: 0, width: 30, height: 30, borderRadius: 8, background: '#18181B', color: '#FFF',
    fontFamily: MONO, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const cardStyle: CSSProperties = { background: '#FFFFFF', border: '1px solid #E6E8EC', borderRadius: 14 }
  // Connector between chapters: 56px each side gives ~132px total
  // gap between Chapter 1's grid and Chapter 2's intro (and again
  // between 2 and 3). Enough that POS, Staffing, and Analytics
  // read as three separate beats inside the demo, not one long blob.
  const connector: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, margin: '56px 0' }

  // While the script is playing, the user can't tap things — it's
  // a film, not a sandbox. After the script finishes the demo
  // becomes interactive (so the most engaged visitors can play).
  const handleTileClick = (m: MenuItem) => { if (!isPlaying) addItem(m) }
  const handleTabClick = (c: Cat) => { if (!isPlaying) setTab(c) }
  const handleContinue = () => { if (!isPlaying) continueToPayment() }
  const handlePay = (m: string) => { if (!isPlaying) pay(m) }

  return (
    <div ref={containerRef} style={{ color: '#18181B', overflowX: 'hidden' }}>
      <style>{`
        @keyframes fsPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.78)}}
        @keyframes fsPop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}
        /* "Money moved" cues for Chapter 2's labor row.
           fsLaborPulse: a tinted backplate that pops in over the
                         Scheduled labor row, sits for ~1s, then
                         fades out. Tells the demo viewer THIS row
                         is the one that just changed.
           fsLaborDelta: a small "+$77.00" indicator that floats up
                         and fades from the labor amount on the
                         right. Anchors the cause-and-effect: the
                         shift you just scheduled cost this much. */
        @keyframes fsLaborPulse{
          0%{opacity:0;transform:scale(0.94)}
          18%{opacity:1;transform:scale(1)}
          70%{opacity:1;transform:scale(1)}
          100%{opacity:0;transform:scale(1)}
        }
        @keyframes fsLaborDelta{
          0%{opacity:0;transform:translateY(2px)}
          18%{opacity:1;transform:translateY(-4px)}
          80%{opacity:1;transform:translateY(-22px)}
          100%{opacity:0;transform:translateY(-32px)}
        }
        /* Touch dot lifecycle, timed to Apple's published UIKit
           standards. UIView's default animation duration is 0.25s
           with an easeInOut curve. We apply that to a finger's
           full tap lifecycle: 250ms touch-down → 200ms hold →
           250ms lift-off, total 700ms. Opacity only — no scale,
           no ripple, no motion.
              0–36%   fade in  (≈252ms — UIKit default)
             36–64%   hold      (≈196ms — the press)
             64–100%  fade out (≈252ms — UIKit default) */
        @keyframes fsTap{
          0%{opacity:0}
          36%{opacity:1}
          64%{opacity:1}
          100%{opacity:0}
        }
        .fs-tile{transition:border-color .15s, box-shadow .15s, transform .08s}
        .fs-tile:hover{border-color:#2563EB;box-shadow:0 6px 16px -10px rgba(37,99,235,0.5)}
        .fs-tile:active{transform:scale(0.97)}
        @media (prefers-reduced-motion: reduce){
          *,*::before,*::after{animation:none!important;transition:none!important}
        }

        /* ============================================================
           Mobile redesign — stacks every chapter's grid into a single
           column at ≤640px. The internal touch-dot system uses
           position:absolute on the card it sits inside, so as long
           as the card itself stays one element wide, refs and
           drag offsets keep working unchanged.
           ============================================================ */
        @media (max-width: 640px){
          /* Chapter 1 — POS card on top, Inventory below. */
          .fs-ch1{grid-template-columns:1fr!important}
          /* Inside the POS card: menu on top, order rail below
             instead of side-by-side. The order rail loses its
             min-height so it flows with content. */
          .fs-pos{grid-template-columns:1fr!important}
          .fs-pos-menu{border-right:none!important;border-bottom:1px solid #EEF0F3!important;padding:10px 14px!important}
          .fs-pos-order{min-height:auto!important;padding:10px 14px!important}
          /* All four category tabs on one row at phone widths.
             Tighter padding + smaller font, and overflow-x: auto as
             a safety in case the longest EN label ("Sandwiches")
             still won't fit on the narrowest devices. */
          .fs-tabs-row{flex-wrap:nowrap!important;gap:5px!important;overflow-x:auto!important;-webkit-overflow-scrolling:touch}
          .fs-tabs-row::-webkit-scrollbar{display:none}
          .fs-tab{font-size:11.5px!important;padding:6px 10px!important;white-space:nowrap!important;flex:0 0 auto!important}
          /* Cap the cart list so adding items doesn't push the POS card
             taller — the rail scrolls internally instead. Combined with
             tighter padding above, the POS card stays compact enough
             that the Inventory card below sits within a thumb-scroll of
             the bars-deplete moment. No auto-scroll: that pulled the
             phone around mid-animation. */
          .fs-cart-list{max-height:110px!important;overflow-y:auto!important}
          /* Chapter 2 — Staffing on top, Finance below. */
          .fs-ch2{grid-template-columns:1fr!important}
          /* Bench row holds 4 staff cards in nowrap — on phone that
             pushes the rightmost cards past the card edge. Wrap to
             a 2×2 grid so every name is visible. */
          .fs-bench-row{flex-wrap:wrap!important}
          .fs-bench-row > div{flex:1 1 calc(50% - 6px)!important;min-width:0!important}
          /* Chapter 3 — chart on top, category + payment mix below. */
          .fs-ch3{grid-template-columns:1fr!important;gap:24px!important}
          /* Connectors — keep but reduce vertical room. */
          .fs-connector{margin:36px 0!important}
          /* Chapter heads — wrap title to two lines naturally. */
          .fs-chap{margin-bottom:20px!important}
          /* Status line — hide on phone. On desktop it pairs with the
             page-level H3 to frame the demo; on phone the H3 is already
             hidden, and this LIVE DEMO ring just wraps to two lines of
             green caps for no payoff before the chapters carry the
             framing themselves. */
          .fs-status{display:none!important}
          /* TODAY'S READ insight panel — on desktop the chart's fixed
             150px height comfortably hosts the absolute-positioned
             overlay; on phone the same content overflows because
             rows wrap. Compact the panel and let it grow below the
             chart edge so nothing gets clipped. */
          .fs-insight{padding:10px 12px!important;bottom:auto!important;min-height:calc(100% + 12px)}
          /* Tighten the table rows (4th child) — smaller gap, smaller
             font, narrower label column so long values like
             "Burgers · 49% mix (Smash Burger #1 · 24 sold)" stop
             wrapping past the box bottom. */
          .fs-insight > div:nth-child(4){margin-top:10px!important;gap:3px!important;font-size:10.5px!important}
          .fs-insight > div:nth-child(4) > div > span:first-child{width:38px!important}
          /* Finance card top row — three KPIs squeezed into a row.
             At desktop they sit side-by-side with vertical borders +
             20px padding-left, total ~420px wide. On phone that
             punches through the right edge. Drop the basis to 70px
             so all three wrap to flex-rows fluidly, shrink the
             amount font, and lose the per-item left-padding that
             the dividers add. */
          .fs-fin-kpis{gap:10px!important}
          .fs-fin-kpis>div{flex:1 1 70px!important;padding-left:0!important;border-left:none!important}
          .fs-fin-kpis>div>div:last-child{font-size:14px!important}
          /* "live with bank context" sits beside the Finance title
             via space-between; on phone the long EN copy collides
             with the title and clips. Drop to two-line wrap by
             hiding the label suffix; keep the green dot. */
          .fs-fin-status{font-size:9px!important;letter-spacing:0!important}
        }
      `}</style>

      {/* status line */}
      <div className="fs-status" style={mono({ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 26, fontSize: 11, letterSpacing: '0.12em', color: GREEN })}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: GREEN, display: 'inline-block', animation: 'fsPulse 1.8s ease-in-out infinite' }} />
        {t(`LIVE DEMO · ${BIZ_NAME} — WATCH THE PRODUCT RING ITSELF UP`, `DEMO EN VIVO · ${BIZ_NAME} — MIRA AL PRODUCTO COBRAR SOLO`)}
      </div>

      {/* CHAPTER 1 */}
      <div className="fs-chap" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 28 }}>
        <div style={chapterNum}>1</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>{t(
            'Sell a dish, and your stock counts itself.',
            'Vendes un platillo, y el inventario se cuenta solo.'
          )}</div>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#52525B', margin: '6px 0 0', maxWidth: 660 }}>{t(
            'Tap a tile. The recipe pulls straight from your stock the moment it’s rung — no second screen, no clipboard, no end-of-night count.',
            'Tocas un botón. La receta saca directo del inventario en el momento — sin segunda pantalla, sin tabla, sin conteo a fin de noche.'
          )}</p>
        </div>
      </div>

      <div className="fs-ch1" style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        {/* POS */}
        <div ref={posCardRef} style={{ ...cardStyle, overflow: 'hidden', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #EEF0F3' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>POS</span>
              <span style={mono({ fontSize: 11, color: '#9CA3AF' })}>{isPlaying ? t('demo in progress…', 'demo en curso…') : t('tap an item to ring it up', 'toca un platillo para cobrarlo')}</span>
            </div>
            <span style={mono({ fontSize: 11, color: '#2563EB', background: '#EFF4FF', padding: '3px 9px', borderRadius: 6 })}>{t('Counter 1', 'Caja 1')}</span>
          </div>
          <div className="fs-pos" style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 0 }}>
            {/* menu */}
            <div className="fs-pos-menu" style={{ padding: '14px 16px', borderRight: '1px solid #EEF0F3' }}>
              <div className="fs-tabs-row" style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 13 }}>
                {TABS.map((c) => (
                  <button
                    key={c}
                    ref={(el) => { tabRefs.current[c] = el }}
                    onClick={() => handleTabClick(c)}
                    className="fs-tab"
                    style={{
                      cursor: isPlaying ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, padding: '7px 13px', borderRadius: 8,
                      border: `1px solid ${c === tab ? '#18181B' : '#E6E8EC'}`, background: c === tab ? '#18181B' : '#FFFFFF',
                      color: c === tab ? '#FFFFFF' : '#52525B', transition: 'all .15s',
                    }}
                  >{catLabel(c)}</button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 9 }}>
                {tiles.map((t) => (
                  <button
                    key={t.item.id}
                    ref={(el) => { tileRefs.current[t.item.id] = el }}
                    className="fs-tile"
                    onClick={() => handleTileClick(t.item)}
                    style={{
                      cursor: isPlaying ? 'default' : 'pointer', textAlign: 'left', fontFamily: 'inherit', background: '#FFFFFF', border: '1px solid #E6E8EC',
                      borderRadius: 11, padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 7,
                    }}
                  >
                    <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 }}>{t.name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={mono({ fontSize: 13, fontWeight: 600 })}>{t.priceStr}</span>
                      <span style={mono({ fontSize: 10, color: t.stockColor })}>{t.stockLabel}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {/* order rail */}
            <div className="fs-pos-order" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', minHeight: 300, position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{t('Current order', 'Orden actual')}</span>
                <span onClick={() => { if (!isPlaying) clearOrder() }} style={mono({ cursor: isPlaying ? 'default' : 'pointer', fontSize: 11, color: '#9CA3AF' })}>{t('Clear', 'Limpiar')}</span>
              </div>
              <div className="fs-cart-list" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {order.length === 0 && (
                  <div style={mono({ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#C3C7CE', fontSize: 11.5, lineHeight: 1.6, padding: '24px 8px' })}>
                    {t('No items yet.', 'Sin platillos aún.')}<br />{t('Tap a dish to start the ticket.', 'Toca un platillo para empezar.')}
                  </div>
                )}
                {order.map((o, i) => (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: '#F8F9FB', border: '1px solid #EEF0F3', borderRadius: 9, padding: '9px 11px', animation: 'fsPop .35s ease' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={mono({ fontSize: 11, color: '#2563EB', fontWeight: 600 })}>{o.qty}×</span>
                      <span style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={mono({ fontSize: 12.5, fontWeight: 600 })}>{fmt(o.price * o.qty)}</span>
                      <span onClick={() => { if (!isPlaying) removeLine(i) }} style={{ cursor: isPlaying ? 'default' : 'pointer', color: '#C3C7CE', fontSize: 14, lineHeight: 1 }}>×</span>
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #EEF0F3' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{t('Total', 'Total')}</span>
                  <span style={mono({ fontSize: 18, fontWeight: 600 })}>{fmt(total)}</span>
                </div>
                {checkout ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button ref={cashRef} onClick={() => handlePay('Cash')} style={{ flex: 1, cursor: isPlaying ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: 11, borderRadius: 10, border: '1px solid #E6E8EC', background: '#FFFFFF', color: '#18181B' }}>{t('Cash', 'Efectivo')}</button>
                    <button ref={cardBtnRef} onClick={() => handlePay('Card')} style={{ flex: 1, cursor: isPlaying ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: 11, borderRadius: 10, border: 'none', background: '#18181B', color: '#FFFFFF' }}>{t('Card', 'Tarjeta')}</button>
                  </div>
                ) : (
                  <button
                    ref={continueRef}
                    onClick={handleContinue}
                    style={{
                      width: '100%', cursor: isPlaying ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600, padding: 12, borderRadius: 10, border: 'none',
                      background: order.length ? '#18181B' : '#EDEFF2', color: order.length ? '#FFFFFF' : '#9CA3AF', transition: 'background .15s',
                    }}
                  >{order.length ? `${t('Continue to payment', 'Continuar al pago')} · ${fmt(total)}` : t('Add an item to continue', 'Agrega un platillo para continuar')}</button>
                )}
              </div>
              {paid && (
                <div
                  style={{
                    position: 'absolute', inset: 0, background: 'rgba(246,247,249,0.92)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10,
                    opacity: paidFading ? 0 : 1,
                    transition: 'opacity 350ms ease-in',
                    pointerEvents: paidFading ? 'none' : 'auto',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 50, height: 50, borderRadius: '50%', background: GREEN, color: '#FFF', fontSize: 24, animation: 'fsPop .4s ease' }}>✓</span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{t(`Paid · ${paid}`, `Pagado · ${paid === 'Cash' ? 'Efectivo' : 'Tarjeta'}`)}</span>
                  <span style={mono({ fontSize: 11, color: '#9CA3AF' })}>{t(`Ticket #${ticket} · posted live`, `Ticket #${ticket} · publicado en vivo`)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Touch dots — small white circles that appear briefly
              where the demo "taps." No motion, no ripple, just a
              subtle press-and-fade so the eye knows where the tap
              happened. */}
          {touches.map((t) => (
            <div
              key={t.id}
              style={{
                position: 'absolute', left: t.x, top: t.y,
                width: 32, height: 32, borderRadius: '50%',
                // Apple iPadOS-style touch dot: a translucent
                // white core that radially fades to fully
                // transparent at the rim, with NO outline ring of
                // any kind. The disc reads as soft contact, not
                // as a drawn circle. The shadow stack is what
                // gives it presence on a white background:
                //   • tight inner shadow → very subtle definition
                //   • mid drop shadow    → grounds it like a fingertip
                //   • wide outer glow    → soft halo, never hard
                background:
                  'radial-gradient(circle, rgba(255,255,255,0.88) 0%, rgba(248,250,253,0.62) 50%, rgba(230,235,245,0.0) 100%)',
                boxShadow:
                  '0 0 0 1px rgba(20,28,42,0.07), 0 1.5px 5px rgba(20,28,42,0.18), 0 0 18px rgba(255,255,255,0.45)',
                pointerEvents: 'none',
                transform: 'translate(-50%, -50%)',
                animation: 'fsTap 700ms cubic-bezier(0.42, 0, 0.58, 1) forwards',
                zIndex: 50,
              }}
            />
          ))}
        </div>

        {/* Inventory */}
        <div style={{ ...cardStyle, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{t('Inventory', 'Inventario')}</span>
            <span style={mono({ fontSize: 10.5, color: '#9CA3AF' })}>{t('sorted by urgency', 'ordenado por urgencia')}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {invRows.map((r) => (
              <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: r.statusColor }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={mono({ fontSize: 12, color: r.valColor })}>{r.valStr}</span>
                      <span style={mono({ fontSize: 9.5, letterSpacing: '0.06em', padding: '2px 6px', borderRadius: 5, background: r.pillBg, color: r.statusColor })}>{r.statusLabel}</span>
                    </span>
                  </div>
                  {/* Slower bar transition (.85s) so the depletion
                      reads as deliberate when the script pays. */}
                  <div style={{ height: 5, background: '#EDEFF2', borderRadius: 99, overflow: 'hidden', marginTop: 6 }}>
                    <div style={{ height: '100%', width: `${r.pct}%`, background: r.statusColor, borderRadius: 99, transition: 'width .85s cubic-bezier(.22, .7, .2, 1), background .3s' }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="fs-connector" style={connector}>
        <div style={{ width: 30, display: 'flex', justifyContent: 'center', color: '#C3C7CE', fontSize: 19 }}>↓</div>
        <span style={mono({ fontSize: 12, color: '#9CA3AF', lineHeight: 1.5 })}>{t(
          'Each ticket depletes ingredients in real time — what you sell tells you what to buy back, and that restock becomes spend.',
          'Cada ticket descuenta ingredientes en tiempo real — lo que vendes te dice qué reponer, y esa compra se vuelve gasto.'
        )}</span>
      </div>

      {/* CHAPTER 2 */}
      <div className="fs-chap" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 28 }}>
        <div style={chapterNum}>2</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>{t(
            'Schedule the shift, and your books update themselves.',
            'Asignas el turno, y los libros se actualizan solos.'
          )}</div>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#52525B', margin: '6px 0 0', maxWidth: 660 }}>{t(
            'Labor, stock, and every other expense lands in Finance automatically — matched against the day’s revenue, with bank context from Plaid. Your net is live, and month-end is already done.',
            'Mano de obra, inventario y cada gasto caen en Finanzas automáticamente — comparados contra la venta del día, con contexto del banco vía Plaid. Tu utilidad va en vivo, y el cierre del mes ya está hecho.'
          )}</p>
        </div>
      </div>

      <div className="fs-ch2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Staffing */}
        <div ref={staffCardRef} style={{ ...cardStyle, padding: '14px 16px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{t('Staffing', 'Personal')}</span>
            <span style={mono({ fontSize: 10.5, color: '#9CA3AF' })}>{t('Front of House · today', 'Salón · hoy')}</span>
          </div>
          <div style={mono({ fontSize: 11, color: '#71717A', marginBottom: 12, transition: 'color .3s' })}>
            {shiftFilled
              ? t('4 on · 28.0h scheduled · today', '4 en turno · 28.0h programadas · hoy')
              : t('3 on · 21.0h scheduled · today', '3 en turno · 21.0h programadas · hoy')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* OPEN shift — fixed across the demo */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={mono({ width: 50, fontSize: 9.5, color: '#9CA3AF', lineHeight: 1.4 })}>{t('OPEN', 'APERT.')}<br />8a–3p</div>
              <div style={{ flex: 1, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ borderLeft: `2px solid ${HOST_COLOR}`, background: '#F8F9FB', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>{STAFF.openHost}</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>{t('Host', 'Anfitrión')}</span>
                </span>
                <span style={{ borderLeft: `2px solid ${SERVER_COLOR}`, background: '#F8F9FB', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>{STAFF.openServer}</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>{t('Server', 'Mesero')}</span>
                </span>
              </div>
            </div>
            {/* MID shift — host always present; server slot starts
                empty and fills when the drag lands. */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#EFF4FF', border: '1px solid #DCE7FF', borderRadius: 9, padding: '7px 8px' }}>
              <div style={mono({ width: 50, fontSize: 9.5, color: '#9CA3AF', lineHeight: 1.4 })}>{t('MID', 'MEDIO')}<br />12p–7p<br /><span style={{ color: '#2563EB', fontWeight: 600 }}>{t('ON NOW', 'EN TURNO')}</span></div>
              <div style={{ flex: 1, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ borderLeft: `2px solid ${HOST_COLOR}`, background: '#FFFFFF', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>{STAFF.midHost}</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>{t('Host', 'Anfitrión')}</span>
                </span>
                {shiftFilled ? (
                  <span style={{ borderLeft: `2px solid ${SERVER_COLOR}`, background: '#FFFFFF', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25, animation: 'fsPop .4s ease' }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>{STAFF.midServer}</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>{t('Server', 'Mesero')}</span>
                  </span>
                ) : (
                  <span ref={emptyShiftSlotRef} style={{ border: '1px dashed #B8C0CC', background: 'transparent', borderRadius: 5, padding: '5px 11px', lineHeight: 1.25, color: '#9CA3AF', display: 'inline-block' }}>
                    <span style={mono({ fontSize: 9.5, display: 'block', letterSpacing: '0.06em' })}>{t('+ SERVER', '+ MESERO')}</span>
                    <span style={mono({ fontSize: 9, color: '#C3C7CE' })}>{t('open', 'libre')}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* Bench — drag source for the simulation */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #E6E8EC' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={mono({ fontSize: 11, color: '#71717A' })}>{t('Bench · Front of House', 'Plantilla · Salón')}</span>
              <span style={mono({ fontSize: 10.5, color: '#9CA3AF', transition: 'color .3s' })}>{shiftFilled ? t('3 available', '3 disponibles') : t('4 available', '4 disponibles')}</span>
            </div>
            {/* Compact row matching the shift-card scale. No hours
                pills — the drag itself (and the empty MID slot
                above) is what tells the story; an additional pill
                here would just compete for attention. */}
            <div className="fs-bench-row" style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }}>
              {BENCH_FOH.map((s) => {
                const isPorkAdams = s.id === 'pork-adams'
                const lifted = isPorkAdams && dragState === 'lift'
                const dragging = isPorkAdams && dragState === 'drag'
                const landing = isPorkAdams && dragState === 'land'
                const inFlight = dragging || landing
                return (
                  <div
                    key={s.id}
                    ref={(el) => { benchItemRefs.current[s.id] = el }}
                    style={{
                      borderLeft: `2px solid ${s.color}`,
                      border: '1px solid #E6E8EC',
                      borderLeftColor: s.color,
                      borderLeftWidth: 2,
                      background: '#FFFFFF',
                      borderRadius: 5,
                      padding: '5px 9px',
                      lineHeight: 1.25,
                      flex: '1 1 0',
                      minWidth: 0,
                      position: 'relative',
                      zIndex: inFlight || lifted ? 10 : 1,
                      transform: inFlight
                        ? `translate(${dragDelta.x}px, ${dragDelta.y}px) scale(${landing ? 1 : 1.06})`
                        : lifted
                          ? 'scale(1.08)'
                          : 'scale(1)',
                      boxShadow: lifted || dragging
                        ? '0 10px 24px rgba(20,28,42,0.22)'
                        : landing
                          ? '0 4px 10px rgba(20,28,42,0.14)'
                          : 'none',
                      transition: dragging
                        ? 'transform 850ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 250ms ease'
                        : landing
                          ? 'transform 280ms ease, box-shadow 280ms ease'
                          : 'transform 320ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 240ms ease',
                    }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                    <span style={mono({ fontSize: 9, color: '#9CA3AF', display: 'block' })}>{s.role === 'Host' ? t('Host', 'Anfitrión') : t('Server', 'Mesero')}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Confirmation overlay — same green-check + ticket-line
              treatment as the POS "Paid" overlay, same staggered
              fade. */}
          {c2Confirm && (
            <div
              style={{
                position: 'absolute', inset: 0, background: 'rgba(246,247,249,0.92)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10,
                opacity: c2ConfirmFading ? 0 : 1,
                transition: 'opacity 350ms ease-in',
                pointerEvents: c2ConfirmFading ? 'none' : 'auto',
                borderRadius: 14,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 50, height: 50, borderRadius: '50%', background: GREEN, color: '#FFF', fontSize: 24, animation: 'fsPop .4s ease' }}>✓</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t('Shift assigned · MID', 'Turno asignado · MEDIO')}</span>
              <span style={mono({ fontSize: 11, color: '#9CA3AF' })}>{t(`${STAFF.midServer} · Server · 7h`, `${STAFF.midServer} · Mesero · 7h`)}</span>
            </div>
          )}

          {/* Drag-along touch dot — Apple-style soft glow that
              appears when the finger lands on Pork Adams and rides
              with him to the drop. Same dragDelta as the bench
              card so they translate as one. Fades out after the
              card lands. */}
          {dragTouchPos && dragState !== 'idle' && (
            <div
              style={{
                position: 'absolute',
                // Center the 32px dot on the touch point via top/left
                // arithmetic, leaving `transform` free to express the
                // drag motion only.
                left: dragTouchPos.x - 16,
                top: dragTouchPos.y - 16,
                width: 32, height: 32, borderRadius: '50%',
                background:
                  'radial-gradient(circle, rgba(255,255,255,0.88) 0%, rgba(248,250,253,0.62) 50%, rgba(230,235,245,0.0) 100%)',
                boxShadow:
                  '0 0 0 1px rgba(20,28,42,0.07), 0 1.5px 5px rgba(20,28,42,0.18), 0 0 18px rgba(255,255,255,0.45)',
                pointerEvents: 'none',
                transform: dragState === 'lift'
                  ? 'translate(0, 0)'
                  : `translate(${dragDelta.x}px, ${dragDelta.y}px)`,
                transition: dragState === 'drag'
                  ? 'transform 850ms cubic-bezier(0.4, 0, 0.2, 1), opacity 320ms ease'
                  : dragState === 'land'
                    ? 'transform 280ms ease, opacity 320ms ease'
                    : 'transform 220ms ease, opacity 320ms ease',
                opacity: dragState === 'done' ? 0 : 1,
                zIndex: 60,
              }}
            />
          )}

          {/* Any transient touch dots (none right now in C2, but
              the infrastructure stays in case we add another beat). */}
          {c2Touches.map((t) => (
            <div
              key={t.id}
              style={{
                position: 'absolute', left: t.x, top: t.y,
                width: 32, height: 32, borderRadius: '50%',
                background:
                  'radial-gradient(circle, rgba(255,255,255,0.88) 0%, rgba(248,250,253,0.62) 50%, rgba(230,235,245,0.0) 100%)',
                boxShadow:
                  '0 0 0 1px rgba(20,28,42,0.07), 0 1.5px 5px rgba(20,28,42,0.18), 0 0 18px rgba(255,255,255,0.45)',
                pointerEvents: 'none',
                transform: 'translate(-50%, -50%)',
                animation: 'fsTap 700ms cubic-bezier(0.42, 0, 0.58, 1) forwards',
                zIndex: 60,
              }}
            />
          ))}
        </div>

        {/* Finance */}
        <div style={{ ...cardStyle, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{t('Finance', 'Finanzas')}</span>
            <span className="fs-fin-status" style={mono({ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: GREEN })}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN, display: 'inline-block' }} />{t('live with bank context', 'en vivo con contexto del banco')}
            </span>
          </div>
          <div className="fs-fin-kpis" style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>
              <div style={mono({ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9CA3AF' })}>{t('Revenue · live', 'Ingresos · en vivo')}</div>
              <div style={mono({ fontSize: 18, fontWeight: 600, color: GREEN, marginTop: 5 })}>{fmt(sales)}</div>
            </div>
            <div style={{ borderLeft: '1px solid #EEF0F3', paddingLeft: 20 }}>
              <div style={mono({ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9CA3AF' })}>{t('Spend', 'Gasto')}</div>
              <div style={mono({ fontSize: 18, fontWeight: 600, color: RED, marginTop: 5, transition: 'color .3s' })}>{fmt(totalSpend)}</div>
            </div>
            <div style={{ borderLeft: '1px solid #EEF0F3', paddingLeft: 20 }}>
              <div style={mono({ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9CA3AF' })}>{t('Net today', 'Neto hoy')}</div>
              <div style={mono({ fontSize: 18, fontWeight: 600, color: netColor, marginTop: 5 })}>{netStr}</div>
            </div>
          </div>
          <div style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', marginBottom: 10 })}>{t('What’s driving spend', 'Qué está moviendo el gasto')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {/* Labor is flagged "est." inline — it's projected from
                the schedule, not from posted clock-ins. A real owner
                would call BS if we presented projected labor as
                confirmed spend. Inventory + operating ARE posted
                (consumption + paid bills), so no tag there. */}
            {[
              { label: t('Scheduled labor', 'Mano de obra'), tag: t('est.', 'est.'), amt: fmt(laborSpend), w: laborPct + '%',     c: '#7C5CFF', key: 'labor' },
              { label: t('Inventory', 'Inventario'),         tag: null,               amt: fmt(INVENTORY_SPEND), w: inventoryPct + '%', c: '#F59E0B', key: 'inv' },
              { label: t('Operating', 'Operación'),          tag: null,               amt: fmt(OPERATING_SPEND), w: operatingPct + '%', c: '#0D9488', key: 'op' },
            ].map((row) => {
              const pulse = row.key === 'labor' && laborPulse
              return (
                <div key={row.label} style={{ position: 'relative' }}>
                  {/* "Money moved" backplate — tinted purple to
                      match the labor bar color, sits behind the
                      row content for ~1.6s when the labor amount
                      ticks up. */}
                  {pulse && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        top: -4, left: -8, right: -8, bottom: -4,
                        borderRadius: 8,
                        background: 'rgba(124, 92, 255, 0.12)',
                        boxShadow: '0 0 0 1px rgba(124, 92, 255, 0.25)',
                        animation: 'fsLaborPulse 1.6s cubic-bezier(0.22, 0.7, 0.2, 1) forwards',
                        pointerEvents: 'none',
                        zIndex: 0,
                      }}
                    />
                  )}
                  {/* Floating delta — anchored to the right edge
                      where the amount sits; floats up + fades to
                      sell the "the shift cost this much" beat. */}
                  {pulse && (
                    <span
                      aria-hidden="true"
                      style={{
                        ...mono({ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.02em' }),
                        position: 'absolute',
                        right: -2, top: -2,
                        color: '#7C5CFF',
                        animation: 'fsLaborDelta 1.6s cubic-bezier(0.22, 0.7, 0.2, 1) forwards',
                        pointerEvents: 'none',
                        zIndex: 3,
                      }}
                    >
                      +{fmt(LABOR_AFTER - LABOR_BEFORE)}
                    </span>
                  )}
                  <div style={{ position: 'relative', zIndex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
                        <span>{row.label}</span>
                        {row.tag && (
                          <span style={mono({ fontSize: 9.5, letterSpacing: '0.04em', color: '#9CA3AF', background: '#F4F5F7', border: '1px solid #E6E8EC', borderRadius: 4, padding: '1px 5px' })}>{row.tag}</span>
                        )}
                      </span>
                      <span style={mono({ color: pulse ? '#7C5CFF' : '#71717A', fontWeight: pulse ? 700 : 400, transition: 'color .3s, font-weight .3s' })}>{row.amt}</span>
                    </div>
                    <div style={{ height: 5, background: '#EDEFF2', borderRadius: 99, overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: row.w,
                          background: row.c,
                          borderRadius: 99,
                          transition: 'width .85s cubic-bezier(.22, .7, .2, 1), box-shadow .35s ease',
                          boxShadow: pulse ? '0 0 10px rgba(124, 92, 255, 0.75)' : 'none',
                        }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="fs-connector" style={connector}>
        <div style={{ width: 30, display: 'flex', justifyContent: 'center', color: '#C3C7CE', fontSize: 19 }}>↓</div>
        <span style={mono({ fontSize: 12, color: '#9CA3AF', lineHeight: 1.5 })}>{t(
          'Every ticket, shift, and invoice rolls up on its own — no spreadsheet, no Sunday-night reconstruction.',
          'Cada ticket, turno y factura se suma solo — sin hoja de cálculo, sin armar la semana el domingo en la noche.'
        )}</span>
      </div>

      {/* CHAPTER 3 */}
      <div className="fs-chap" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 28 }}>
        <div style={chapterNum}>3</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>{t(
            'Hit close, and the day reads itself.',
            'Cierras el día, y el día se lee solo.'
          )}</div>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#52525B', margin: '6px 0 0', maxWidth: 660 }}>{t(
            'What sold, how people paid, where the week is trending — one honest picture, plain enough to read between rushes. The chart’s last bar is today.',
            'Qué se vendió, cómo pagó la gente, hacia dónde va la semana — una sola foto honesta, clara para leer entre la comida y la cena. La última barra del gráfico es hoy.'
          )}</p>
        </div>
      </div>

      <div ref={analyticsCardRef} style={{ ...cardStyle, padding: '18px 20px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{t('Analytics', 'Analíticas')}</span>
          <span style={mono({ fontSize: 10.5, color: '#9CA3AF' })}>{t('last 14 days', 'últimos 14 días')}</span>
        </div>
        <div className="fs-ch3" style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 32 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF' })}>{t('Daily rhythm', 'Ritmo diario')}</span>
              {/* Time ticker / close badge — counts up during the
                  time-lapse, settles to "Closed · 11:43 PM" with a
                  green check once the day closes. */}
              {c3Closed ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, animation: 'fsPop .4s ease' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 13, height: 13, borderRadius: '50%', background: GREEN, color: '#FFF', fontSize: 8.5 }}>✓</span>
                  <span style={mono({ fontSize: 10.5, color: GREEN, fontWeight: 600, letterSpacing: '0.04em' })}>{t('Closed · 11:43 PM', 'Cerrado · 11:43 PM')}</span>
                </span>
              ) : (
                <span style={mono({ fontSize: 10.5, color: '#9CA3AF', letterSpacing: '0.04em' })}>{c3TimeLabel || '—'}</span>
              )}
            </div>
            {/* The chart container is position:relative so the
                insight overlay can `inset:0` over it. */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 150 }}>
                {dailyBars.map((b, i) => {
                  const isLast = i === dailyBars.length - 1
                  // Today's bar carries the time-lapse multiplier;
                  // every bar (today included) is gated by the
                  // global sweep scale. During the staggered sweep
                  // each bar's transition-delay = index × 45ms,
                  // creating the left-to-right wake-up wave.
                  const todayMult = isLast ? c3LastBarScale : 1
                  const displayH = b.h * todayMult * c3GlobalScale
                  return (
                    <div
                      key={i}
                      ref={isLast ? todayBarRef : undefined}
                      style={{ flex: 1, display: 'flex', alignItems: 'flex-end', height: '100%' }}
                    >
                      <div
                        style={{
                          width: '100%',
                          height: `${displayH}%`,
                          background: b.color,
                          borderRadius: '3px 3px 0 0',
                          // Fold the per-bar sweep delay INTO the
                          // transition shorthand to avoid React's
                          // warning about mixing the `transition`
                          // shorthand with a separate `transitionDelay`
                          // property — the shorthand implicitly
                          // resets delay to 0 and the two then race.
                          transition: c3BarsAnimate
                            ? `height .6s cubic-bezier(.2,.7,.2,1) ${c3InSweep ? `${i * 45}ms` : '0ms'}`
                            : 'none',
                        }}
                      />
                    </div>
                  )
                })}
              </div>

              {/* Insight panel — dark callout that pops in over the
                  chart area when the tap lands on today's bar. The
                  bars peek through faintly because the chart stays
                  mounted underneath; this keeps the visual anchor
                  while shifting attention to the recap content. */}
              {c3Insight && (
                <div
                  className="fs-insight"
                  style={{
                    position: 'absolute',
                    top: -6, left: -6, right: -6, bottom: -6,
                    background: 'rgba(24,24,27,0.96)',
                    color: '#FAF9F6',
                    borderRadius: 11,
                    padding: '14px 16px',
                    boxShadow: '0 18px 40px -20px rgba(24,24,27,0.45)',
                    animation: 'fsPop 420ms cubic-bezier(0.34, 1.4, 0.64, 1)',
                    opacity: c3InsightFading ? 0 : 1,
                    transition: 'opacity 350ms ease-in',
                    pointerEvents: c3InsightFading ? 'none' : 'auto',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={mono({ fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#A1A1A6' })}>{t('Today’s read', 'Lectura de hoy')}</span>
                    <span style={mono({ fontSize: 9.5, letterSpacing: '0.04em', color: '#A1A1A6' })}>{t('Thu · Mar 14', 'Jue · 14 mar')}</span>
                  </div>
                  <div style={mono({ fontSize: 22, fontWeight: 600, lineHeight: 1.05, color: '#FAF9F6' })}>{fmt(sales)}</div>
                  <div style={mono({ fontSize: 10.5, color: GREEN, marginTop: 4, letterSpacing: '0.04em' })}>
                    {t('↑ +$412.00 vs last Thursday', '↑ +$412.00 vs jueves pasado')}
                  </div>
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, lineHeight: 1.4 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={mono({ color: '#A1A1A6', width: 60, flexShrink: 0 })}>{t('Top', 'Lo más')}</span>
                      <span style={{ color: '#FAF9F6' }}>{t(
                        `${catLabel('Tacos')} · 49% mix`,
                        `${catLabel('Tacos')} · 49% del mix`
                      )} &nbsp;<span style={mono({ color: '#A1A1A6' })}>{lang === 'es' ? '(Pastor #1 · 24 vendidos)' : '(Smash Burger #1 · 24 sold)'}</span></span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={mono({ color: '#A1A1A6', width: 60, flexShrink: 0 })}>{t('Peak', 'Pico')}</span>
                      <span style={{ color: '#FAF9F6' }}>1:00 PM &nbsp;<span style={mono({ color: '#A1A1A6' })}>{t('($263 in 30 min)', '($263 en 30 min)')}</span></span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={mono({ color: '#A1A1A6', width: 60, flexShrink: 0 })}>{t('Cash', 'Efectivo')}</span>
                      <span style={{ color: '#FAF9F6' }}>59% &nbsp;<span style={mono({ color: '#A1A1A6' })}>{t('(+18 pts vs avg)', '(+18 pts vs promedio)')}</span></span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={mono({ color: AMBER, width: 60, flexShrink: 0 })}>{t('Flag', 'Alerta')}</span>
                      <span style={{ color: '#FAF9F6' }}>{lang === 'es' ? 'Horchata' : 'Lemonade mix'} &nbsp;<span style={mono({ color: '#A1A1A6' })}>{t('(out — reorder)', '(agotado — reabastecer)')}</span></span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div>
            <div style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', marginBottom: 9 })}>{t('Category mix', 'Mix por categoría')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {catBars.map((c) => (
                <div key={c.name}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color, display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontWeight: 500 }}>{c.name}</span>
                    </span>
                    <span style={mono({ color: '#71717A' })}>{c.pctStr}</span>
                  </div>
                  <div style={{ height: 6, background: '#EDEFF2', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${c.pct}%`, background: c.color, borderRadius: 99, transition: 'width .55s ease' }} />
                  </div>
                </div>
              ))}
            </div>
            <div style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', marginBottom: 9 })}>{t('Payment mix', 'Mix por pago')}</div>
            <div style={{ display: 'flex', height: 9, borderRadius: 99, overflow: 'hidden', marginBottom: 9 }}>
              <div style={{ width: `${cardPct}%`, background: '#0EA5E9', transition: 'width .5s' }} />
              <div style={{ width: `${cashPct}%`, background: '#EC4899', transition: 'width .5s' }} />
              <div style={{ width: `${otherPct}%`, background: '#94A3B8', transition: 'width .5s' }} />
            </div>
            <div style={mono({ display: 'flex', gap: 16, fontSize: 11, color: '#71717A' })}>
              <span><span style={{ color: '#0EA5E9' }}>■</span> {t('Card', 'Tarjeta')} {cardPct}%</span>
              <span><span style={{ color: '#EC4899' }}>■</span> {t('Cash', 'Efectivo')} {cashPct}%</span>
              <span><span style={{ color: '#94A3B8' }}>■</span> {t('Other', 'Otro')} {otherPct}%</span>
            </div>
          </div>
        </div>

        {/* Touch dot for the analytics chapter — lands on today's
            bar a beat before the insight panel pops in, so the tap
            visibly causes the reveal. Same Apple-style soft glow
            + 700ms tap timing as POS and Staffing. */}
        {c3Touches.map((t) => (
          <div
            key={t.id}
            style={{
              position: 'absolute', left: t.x, top: t.y,
              width: 32, height: 32, borderRadius: '50%',
              background:
                'radial-gradient(circle, rgba(255,255,255,0.88) 0%, rgba(248,250,253,0.62) 50%, rgba(230,235,245,0.0) 100%)',
              boxShadow:
                '0 0 0 1px rgba(20,28,42,0.07), 0 1.5px 5px rgba(20,28,42,0.18), 0 0 18px rgba(255,255,255,0.45)',
              pointerEvents: 'none',
              transform: 'translate(-50%, -50%)',
              animation: 'fsTap 700ms cubic-bezier(0.42, 0, 0.58, 1) forwards',
              zIndex: 60,
            }}
          />
        ))}
      </div>
    </div>
  )
}
