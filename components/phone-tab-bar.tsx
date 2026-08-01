'use client'

// ----------------------------------------------------------------
// PhoneTabBar — the phone-only ("<md") bottom navigation.
//
// Four fixed tabs (Home / Staff / Stock / Money) mapped to the
// existing dashboard / staffing / inventory / finance routes.
// Rendered by `AppShell` at <md; hidden on tablet + desktop where
// the icon rail / labeled sidebar handle navigation.
//
// Tabs are named by destination (nouns an owner says out loud) —
// never features like Analytics or Operations. Menu / POS /
// Analytics / Settings are intentionally NOT tabs; those flows
// need a keyboard or precision and belong on the tablet.
// ----------------------------------------------------------------

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const INK = '#18181B'
const LINE = '#E7E6E2'
const FAINT = '#A1A1A6'
const MONO = "'Geist Mono', ui-monospace, monospace"

type TabKey = 'home' | 'staff' | 'stock' | 'money'
type Tab = {
  key: TabKey
  label: string
  href: string
  match: (pathname: string) => boolean
}

const TABS: Tab[] = [
  { key: 'home',  label: 'Home',  href: '/dashboard', match: (p) => p === '/' || p.startsWith('/dashboard') },
  { key: 'staff', label: 'Staff', href: '/staffing',  match: (p) => p.startsWith('/staffing') },
  { key: 'stock', label: 'Stock', href: '/inventory', match: (p) => p.startsWith('/inventory') },
  { key: 'money', label: 'Money', href: '/finance',   match: (p) => p.startsWith('/finance') },
]

export function PhoneTabBar() {
  const pathname = usePathname() ?? '/'
  return (
    <nav
      aria-label="Primary"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30,
        display: 'flex',
        borderTop: `1px solid ${LINE}`,
        background: '#fff',
        padding: '8px 8px calc(18px + env(safe-area-inset-bottom))',
        fontFamily: "'Geist', system-ui, sans-serif",
      }}
    >
      {TABS.map((t) => {
        const active = t.match(pathname)
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            style={{
              flex: 1, minWidth: 0, minHeight: 48,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '4px 0', textDecoration: 'none',
              color: active ? INK : FAINT,
            }}
          >
            <TabIcon k={t.key} />
            <span style={{ fontSize: 10, fontWeight: active ? 600 : 500, fontFamily: MONO === MONO ? undefined : MONO }}>
              {t.label}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}

// Lucide-shaped tab glyphs. Same silhouettes as the sidebar rail.
function TabIcon({ k }: { k: TabKey }) {
  const p = {
    width: 23, height: 23, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (k === 'home') {
    return (
      <svg {...p}>
        <path d="M3.4 10.2L12 3.4l8.6 6.8v9.2a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6v-9.2z" />
        <path d="M9.4 21v-6.6h5.2V21" />
      </svg>
    )
  }
  if (k === 'staff') {
    return (
      <svg {...p}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <path d="M16 3.128a4 4 0 0 1 0 7.744" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <circle cx="9" cy="7" r="4" />
      </svg>
    )
  }
  if (k === 'stock') {
    return (
      <svg {...p}>
        <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
        <path d="M12 22V12" />
        <path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" />
      </svg>
    )
  }
  return (
    <svg {...p}>
      <line x1="12" x2="12" y1="2" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  )
}
