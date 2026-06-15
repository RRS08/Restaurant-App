'use client'

// ----------------------------------------------------------------
// FloorSim — interactive "ring it up" product demo for the marketing
// page. A tappable POS whose sales drive Inventory, Staffing, Finance
// and Analytics live. Self-contained client component.
//
// Converted from the design prototype. Uses Geist Mono (via the
// --font-geist-mono CSS var set in app/layout.tsx) for the ledger
// texture so it matches the app.
// ----------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'

const GREEN = '#16A34A'
const AMBER = '#B45309'
const RED = '#DC2626'

type Cat = 'Tacos' | 'Mariscos' | 'Sides' | 'Drinks'

interface MenuItem {
  id: string
  name: string
  price: number
  cat: Cat
  inv: Array<[string, number]>
}

const MENU: MenuItem[] = [
  { id: 'pastor',   name: 'Tacos al Pastor', price: 3.5,  cat: 'Tacos',    inv: [['pastor', 1], ['tortillas', 2]] },
  { id: 'asada',    name: 'Tacos de Asada',  price: 3.75, cat: 'Tacos',    inv: [['tortillas', 2]] },
  { id: 'birria',   name: 'Quesabirria',     price: 4.75, cat: 'Tacos',    inv: [['birria', 1], ['queso', 1], ['tortillas', 2]] },
  { id: 'pollo',    name: 'Tacos de Pollo',  price: 3.25, cat: 'Tacos',    inv: [['tortillas', 2]] },
  { id: 'ceviche',  name: 'Ceviche Tostada', price: 5.5,  cat: 'Mariscos', inv: [['limes', 2]] },
  { id: 'camaron',  name: 'Camarones',       price: 7.5,  cat: 'Mariscos', inv: [['limes', 1]] },
  { id: 'elote',    name: 'Elote',           price: 4.0,  cat: 'Sides',    inv: [['queso', 1]] },
  { id: 'guac',     name: 'Chips & Guac',    price: 5.0,  cat: 'Sides',    inv: [] },
  { id: 'horchata', name: 'Horchata',        price: 3.5,  cat: 'Drinks',   inv: [['horchata', 1]] },
  { id: 'jamaica',  name: 'Agua de Jamaica', price: 3.0,  cat: 'Drinks',   inv: [] },
  { id: 'jarritos', name: 'Jarritos',        price: 2.75, cat: 'Drinks',   inv: [] },
]

const TABS: Cat[] = ['Tacos', 'Mariscos', 'Sides', 'Drinks']

const SALES_SEED = 1842.5
const ORDERS_SEED = 53
const CASH_SEED = 31
const CARD_SEED = 19
const OTHER_SEED = 3
const CAT_SEED: Record<Cat, number> = { Tacos: 902, Mariscos: 404, Sides: 288, Drinks: 248 }
const DAILY_SEED = [2100, 1850, 2320, 1980, 2640, 3100, 2890, 2010, 1760, 2450, 2980, 3210, 2740]

interface InvItem { name: string; u: number; cap: number; reorder: number }
interface OrderLine { id: string; name: string; price: number; qty: number }

const fmt = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function initialInv(): Record<string, InvItem> {
  return {
    pastor:    { name: 'Pastor (marinated)', u: 24, cap: 40,  reorder: 10 },
    tortillas: { name: 'Tortillas',          u: 88, cap: 200, reorder: 40 },
    queso:     { name: 'Queso Oaxaca',       u: 9,  cap: 30,  reorder: 10 },
    birria:    { name: 'Birria',             u: 13, cap: 25,  reorder: 8 },
    horchata:  { name: 'Horchata mix',       u: 16, cap: 40,  reorder: 10 },
    limes:     { name: 'Limes',              u: 7,  cap: 60,  reorder: 14 },
  }
}

export default function FloorSim() {
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
  const [ticket, setTicket] = useState(6041)
  const [mounted, setMounted] = useState(false)

  const touched = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

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

  const onTap = (m: MenuItem) => { touched.current = true; addItem(m) }
  const removeLine = (i: number) => { setOrder((p) => p.filter((_, idx) => idx !== i)); setCheckout(false) }
  const clearOrder = () => { setOrder([]); setCheckout(false) }
  const continueToPayment = () => { if (order.length) setCheckout(true) }

  const pay = (method: string) => {
    const total = order.reduce((a, o) => a + o.price * o.qty, 0)
    const nextInv: Record<string, InvItem> = JSON.parse(JSON.stringify(inv))
    const nextCat = { ...catLive }
    order.forEach((o) => {
      const m = MENU.find((x) => x.id === o.id)!
      nextCat[m.cat] = (nextCat[m.cat] || 0) + o.price * o.qty
      m.inv.forEach(([k, n]) => { if (nextInv[k]) nextInv[k].u = Math.max(0, nextInv[k].u - n * o.qty) })
    })
    setOrder([]); setCheckout(false)
    setSalesPaid((v) => v + total)
    setOrdersPaid((v) => v + 1)
    if (method === 'Cash') setCashPaid((v) => v + 1)
    if (method === 'Card') setCardPaid((v) => v + 1)
    setCatLive(nextCat); setInv(nextInv); setPaid(method); setTicket((v) => v + 1)
    const t = setTimeout(() => setPaid(null), 1700)
    timers.current.push(t)
  }

  useEffect(() => {
    timers.current = []
    timers.current.push(setTimeout(() => setMounted(true), 80))
    timers.current.push(setTimeout(() => { if (!touched.current) addItem(MENU[0]) }, 1600))
    timers.current.push(setTimeout(() => {
      if (!touched.current) setOrder((prev) => (prev.length === 1 ? (() => {
        const m = MENU[8]; return [...prev, { id: m.id, name: m.name, price: m.price, qty: 1 }]
      })() : prev))
    }, 2500))
    return () => { timers.current.forEach(clearTimeout) }
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
  const tiles = MENU.filter((m) => m.cat === tab).map((m) => {
    const st = stockFor(m)
    return { item: m, name: m.name, priceStr: fmt(m.price), stockLabel: st === 'OK' ? '' : st, stockColor: stockColor[st] }
  })
  const total = order.reduce((a, o) => a + o.price * o.qty, 0)
  const sales = SALES_SEED + salesPaid
  const orders = ORDERS_SEED + ordersPaid

  const rank: Record<string, number> = { Out: 0, Low: 1, OK: 2 }
  const invRows = Object.values(inv).map((it) => {
    const st = it.u <= 0 ? 'Out' : it.u <= it.reorder ? 'Low' : 'OK'
    const color = st === 'Out' ? RED : st === 'Low' ? AMBER : GREEN
    const pillBg = st === 'Out' ? '#FCECEC' : st === 'Low' ? '#FBF1E3' : '#ECF6EF'
    return {
      name: it.name, valStr: it.u.toFixed(2), valColor: color, statusLabel: st.toUpperCase(),
      statusColor: color, pillBg, pct: mounted ? Math.max(3, Math.min(100, Math.round((it.u / it.cap) * 100))) : 0, r: rank[st],
    }
  }).sort((a, b) => a.r - b.r)

  const rawDaily = [...DAILY_SEED, sales]
  const maxDaily = Math.max(...rawDaily)
  const dailyBars = rawDaily.map((v, i) => ({
    h: mounted ? Math.max(4, Math.round((v / maxDaily) * 100)) : 0,
    color: i === rawDaily.length - 1 ? '#2563EB' : '#C9D2DE',
  }))

  const catTotal = TABS.reduce((a, t) => a + CAT_SEED[t] + catLive[t], 0)
  const catBars = TABS.map((t) => {
    const v = CAT_SEED[t] + catLive[t]
    const pct = Math.round((v / catTotal) * 100)
    return { name: t, pct: mounted ? pct : 0, pctStr: pct + '%' }
  })

  const cash = CASH_SEED + cashPaid, card = CARD_SEED + cardPaid, other = OTHER_SEED
  const ptot = cash + card + other
  const cardPct = Math.round((card / ptot) * 100)
  const cashPct = Math.round((cash / ptot) * 100)
  const otherPct = Math.max(0, 100 - cardPct - cashPct)

  const spend = 1538.5
  const net = sales - spend
  const netStr = (net >= 0 ? '+' : '−') + fmt(Math.abs(net))
  const netColor = net >= 0 ? GREEN : RED

  // ---- small style helpers ----
  const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
  const chapterNum: CSSProperties = {
    flexShrink: 0, width: 30, height: 30, borderRadius: 8, background: '#18181B', color: '#FFF',
    fontFamily: MONO, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const cardStyle: CSSProperties = { background: '#FFFFFF', border: '1px solid #E6E8EC', borderRadius: 14 }
  const connector: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, margin: '18px 0' }

  return (
    <div style={{ color: '#18181B' }}>
      <style>{`
        @keyframes fsPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.78)}}
        @keyframes fsPop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}
        .fs-tile{transition:border-color .15s, box-shadow .15s, transform .08s}
        .fs-tile:hover{border-color:#2563EB;box-shadow:0 6px 16px -10px rgba(37,99,235,0.5)}
        .fs-tile:active{transform:scale(0.97)}
      `}</style>

      {/* status line */}
      <div style={mono({ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 26, fontSize: 11, letterSpacing: '0.12em', color: GREEN })}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: GREEN, display: 'inline-block', animation: 'fsPulse 1.8s ease-in-out infinite' }} />
        LIVE DEMO · TACOS DON PORK — TAP THE POS TO DRIVE THE WHOLE SYSTEM
      </div>

      {/* CHAPTER 1 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={chapterNum}>1</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>It starts at the register</div>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#52525B', margin: '6px 0 0', maxWidth: 660 }}>
            Every sale begins at the counter. Tap a dish and its recipe pulls straight from your stock the moment you ring it — no second screen to update, no end-of-night count. Watch the ingredients on the right move with each tap.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        {/* POS */}
        <div style={{ ...cardStyle,overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #EEF0F3' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>POS</span>
              <span style={mono({ fontSize: 11, color: '#9CA3AF' })}>tap an item to ring it up</span>
            </div>
            <span style={mono({ fontSize: 11, color: '#2563EB', background: '#EFF4FF', padding: '3px 9px', borderRadius: 6 })}>Counter 1</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 0 }}>
            {/* menu */}
            <div style={{ padding: '14px 16px', borderRight: '1px solid #EEF0F3' }}>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 13 }}>
                {TABS.map((t) => (
                  <button key={t} onClick={() => setTab(t)} style={{
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, padding: '7px 13px', borderRadius: 8,
                    border: `1px solid ${t === tab ? '#18181B' : '#E6E8EC'}`, background: t === tab ? '#18181B' : '#FFFFFF',
                    color: t === tab ? '#FFFFFF' : '#52525B', transition: 'all .15s',
                  }}>{t}</button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 9 }}>
                {tiles.map((t) => (
                  <button key={t.item.id} className="fs-tile" onClick={() => onTap(t.item)} style={{
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', background: '#FFFFFF', border: '1px solid #E6E8EC',
                    borderRadius: 11, padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 7,
                  }}>
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
            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', minHeight: 300, position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Current order</span>
                <span onClick={clearOrder} style={mono({ cursor: 'pointer', fontSize: 11, color: '#9CA3AF' })}>Clear</span>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {order.length === 0 && (
                  <div style={mono({ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#C3C7CE', fontSize: 11.5, lineHeight: 1.6, padding: '24px 8px' })}>
                    No items yet.<br />Tap a dish to start the ticket.
                  </div>
                )}
                {order.map((o, i) => (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: '#F8F9FB', border: '1px solid #EEF0F3', borderRadius: 9, padding: '9px 11px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={mono({ fontSize: 11, color: '#2563EB', fontWeight: 600 })}>{o.qty}×</span>
                      <span style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={mono({ fontSize: 12.5, fontWeight: 600 })}>{fmt(o.price * o.qty)}</span>
                      <span onClick={() => removeLine(i)} style={{ cursor: 'pointer', color: '#C3C7CE', fontSize: 14, lineHeight: 1 }}>×</span>
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #EEF0F3' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Total</span>
                  <span style={mono({ fontSize: 18, fontWeight: 600 })}>{fmt(total)}</span>
                </div>
                {checkout ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => pay('Cash')} style={{ flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: 11, borderRadius: 10, border: '1px solid #E6E8EC', background: '#FFFFFF', color: '#18181B' }}>Cash</button>
                    <button onClick={() => pay('Card')} style={{ flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: 11, borderRadius: 10, border: 'none', background: '#18181B', color: '#FFFFFF' }}>Card</button>
                  </div>
                ) : (
                  <button onClick={continueToPayment} style={{
                    width: '100%', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600, padding: 12, borderRadius: 10, border: 'none',
                    background: order.length ? '#18181B' : '#EDEFF2', color: order.length ? '#FFFFFF' : '#9CA3AF', transition: 'background .15s',
                  }}>{order.length ? `Continue to payment · ${fmt(total)}` : 'Add an item to continue'}</button>
                )}
              </div>
              {paid && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(246,247,249,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 50, height: 50, borderRadius: '50%', background: GREEN, color: '#FFF', fontSize: 24, animation: 'fsPop .4s ease' }}>✓</span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>Paid · {paid}</span>
                  <span style={mono({ fontSize: 11, color: '#9CA3AF' })}>Ticket #{ticket} · posted live</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Inventory */}
        <div style={{ ...cardStyle,padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Inventory</span>
            <span style={mono({ fontSize: 10.5, color: '#9CA3AF' })}>sorted by urgency</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {invRows.map((r) => (
              <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: r.statusColor }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={mono({ fontSize: 12, color: r.valColor })}>{r.valStr}</span>
                      <span style={mono({ fontSize: 9.5, letterSpacing: '0.06em', padding: '2px 6px', borderRadius: 5, background: r.pillBg, color: r.statusColor })}>{r.statusLabel}</span>
                    </span>
                  </div>
                  <div style={{ height: 5, background: '#EDEFF2', borderRadius: 99, overflow: 'hidden', marginTop: 6 }}>
                    <div style={{ height: '100%', width: `${r.pct}%`, background: r.statusColor, borderRadius: 99, transition: 'width .55s ease, background .3s' }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={connector}>
        <div style={{ width: 30, display: 'flex', justifyContent: 'center', color: '#C3C7CE', fontSize: 19 }}>↓</div>
        <span style={mono({ fontSize: 12, color: '#9CA3AF', lineHeight: 1.5 })}>Each ticket depletes ingredients in real time — what you sell tells you what to buy back, and that restock becomes spend.</span>
      </div>

      {/* CHAPTER 2 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={chapterNum}>2</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>Stock and people become cost</div>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#52525B', margin: '6px 0 0', maxWidth: 660 }}>
            Your two biggest levers — who&apos;s on the floor and what&apos;s in the walk-in — flow straight into Finance. Scheduled labor and inventory spend post automatically and get matched against the day&apos;s revenue, so your net is live, with bank context from Plaid.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Staffing */}
        <div style={{ ...cardStyle,padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Staffing</span>
            <span style={mono({ fontSize: 10.5, color: '#9CA3AF' })}>Front of House · today</span>
          </div>
          <div style={mono({ fontSize: 11, color: '#71717A', marginBottom: 12 })}>4 on · 28.0h scheduled · today</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={mono({ width: 50, fontSize: 9.5, color: '#9CA3AF', lineHeight: 1.4 })}>OPEN<br />8a–3p</div>
              <div style={{ flex: 1, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ borderLeft: '2px solid #167C54', background: '#F8F9FB', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>John Pork</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>Host</span>
                </span>
                <span style={{ borderLeft: '2px solid #7C5CFF', background: '#F8F9FB', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>LePork James</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>Server</span>
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#EFF4FF', border: '1px solid #DCE7FF', borderRadius: 9, padding: '7px 8px' }}>
              <div style={mono({ width: 50, fontSize: 9.5, color: '#9CA3AF', lineHeight: 1.4 })}>MID<br />12p–7p<br /><span style={{ color: '#2563EB', fontWeight: 600 }}>ON NOW</span></div>
              <div style={{ flex: 1, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ borderLeft: '2px solid #167C54', background: '#FFFFFF', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>Charlie Pork</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>Host</span>
                </span>
                <span style={{ borderLeft: '2px solid #7C5CFF', background: '#FFFFFF', borderRadius: 5, padding: '5px 9px', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, display: 'block' }}>Pork Adams</span><span style={mono({ fontSize: 9, color: '#9CA3AF' })}>Server</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Finance */}
        <div style={{ ...cardStyle,padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Finance</span>
            <span style={mono({ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: GREEN })}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN, display: 'inline-block' }} />live with bank context
            </span>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>
              <div style={mono({ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9CA3AF' })}>Revenue · live</div>
              <div style={mono({ fontSize: 18, fontWeight: 600, color: GREEN, marginTop: 5 })}>{fmt(sales)}</div>
            </div>
            <div style={{ borderLeft: '1px solid #EEF0F3', paddingLeft: 20 }}>
              <div style={mono({ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9CA3AF' })}>Spend</div>
              <div style={mono({ fontSize: 18, fontWeight: 600, color: RED, marginTop: 5 })}>{fmt(spend)}</div>
            </div>
            <div style={{ borderLeft: '1px solid #EEF0F3', paddingLeft: 20 }}>
              <div style={mono({ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9CA3AF' })}>Net today</div>
              <div style={mono({ fontSize: 18, fontWeight: 600, color: netColor, marginTop: 5 })}>{netStr}</div>
            </div>
          </div>
          <div style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', marginBottom: 10 })}>What&apos;s driving spend</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {[
              { label: 'Scheduled labor', amt: '$716.00', w: '47%', c: '#7C5CFF' },
              { label: 'Inventory', amt: '$642.50', w: '42%', c: '#F59E0B' },
              { label: 'Operating', amt: '$180.00', w: '11%', c: '#16A34A' },
            ].map((row) => (
              <div key={row.label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span>{row.label}</span><span style={mono({ color: '#71717A' })}>{row.amt}</span>
                </div>
                <div style={{ height: 5, background: '#EDEFF2', borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: row.w, background: row.c, borderRadius: 99 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={connector}>
        <div style={{ width: 30, display: 'flex', justifyContent: 'center', color: '#C3C7CE', fontSize: 19 }}>↓</div>
        <span style={mono({ fontSize: 12, color: '#9CA3AF', lineHeight: 1.5 })}>Every ticket, shift, and invoice rolls up on its own — no spreadsheet, no Sunday-night reconstruction.</span>
      </div>

      {/* CHAPTER 3 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={chapterNum}>3</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>The whole day, in one read</div>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#52525B', margin: '6px 0 0', maxWidth: 660 }}>
            By close it&apos;s a single honest picture: what sold, how people paid, and where the week is trending. Plain enough to read between the lunch and dinner rush. The chart&apos;s last bar is today — it grows with every order you ring above.
          </p>
        </div>
      </div>

      <div style={{ ...cardStyle,padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Analytics</span>
          <span style={mono({ fontSize: 10.5, color: '#9CA3AF' })}>last 14 days</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 32 }}>
          <div>
            <div style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', marginBottom: 10 })}>Daily rhythm</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 150 }}>
              {dailyBars.map((b, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', height: '100%' }}>
                  <div style={{ width: '100%', height: `${b.h}%`, background: b.color, borderRadius: '3px 3px 0 0', transition: 'height .6s cubic-bezier(.2,.7,.2,1)' }} />
                </div>
              ))}
            </div>
          </div>
          <div>
            <div style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', marginBottom: 9 })}>Category mix</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {catBars.map((c) => (
                <div key={c.name}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 500 }}>{c.name}</span>
                    <span style={mono({ color: '#71717A' })}>{c.pctStr}</span>
                  </div>
                  <div style={{ height: 6, background: '#EDEFF2', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${c.pct}%`, background: '#18181B', borderRadius: 99, transition: 'width .55s ease' }} />
                  </div>
                </div>
              ))}
            </div>
            <div style={mono({ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', marginBottom: 9 })}>Payment mix</div>
            <div style={{ display: 'flex', height: 9, borderRadius: 99, overflow: 'hidden', marginBottom: 9 }}>
              <div style={{ width: `${cardPct}%`, background: '#7C5CFF', transition: 'width .5s' }} />
              <div style={{ width: `${cashPct}%`, background: '#F59E0B', transition: 'width .5s' }} />
              <div style={{ width: `${otherPct}%`, background: '#D4D7DD', transition: 'width .5s' }} />
            </div>
            <div style={mono({ display: 'flex', gap: 16, fontSize: 11, color: '#71717A' })}>
              <span><span style={{ color: '#7C5CFF' }}>■</span> Card {cardPct}%</span>
              <span><span style={{ color: '#F59E0B' }}>■</span> Cash {cashPct}%</span>
              <span><span style={{ color: '#D4D7DD' }}>■</span> Other {otherPct}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
