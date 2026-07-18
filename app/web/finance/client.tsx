'use client'

// ----------------------------------------------------------------
// WebFinanceClient — web-native finance display.
//
//   eyebrow + headline + summary
//   four-cell strip (revenue · expenses · labor · inventory spend)
//   net for the period
//   recent expenses list
// ----------------------------------------------------------------

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { makeT, type Lang } from '@/lib/i18n'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
const wrap = (extra: CSSProperties = {}): CSSProperties => ({ maxWidth: 1160, margin: '0 auto', ...extra })
const eyebrow: CSSProperties = mono({
  fontSize: 11.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6B6B70',
})

interface Expense {
  id: string; category: string; amount: number
  expenseDate: string; vendorName: string | null
  notes: string | null; isInventoryRelated: boolean
}

interface Props {
  lang: Lang
  revenue7d: number
  expenseTotal7d: number
  inventorySpend7d: number
  laborEstimate7d: number
  recentExpenses: Expense[]
}

const fmt = (n: number) => `$${n.toFixed(2)}`

export default function WebFinanceClient({
  lang, revenue7d, expenseTotal7d, inventorySpend7d, laborEstimate7d, recentExpenses,
}: Props) {
  const t = makeT(lang)
  const totalOutflow = expenseTotal7d + laborEstimate7d
  const net = revenue7d - totalOutflow

  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>
          {t('Finance', 'Finanzas')} · {t('Last 7 days', 'Últimos 7 días')}
        </div>
        <h1 style={{
          fontSize: 'clamp(36px, 5.4vw, 56px)', lineHeight: 1.02,
          letterSpacing: '-1.6px', fontWeight: 700, margin: '14px 0 0', color: '#18181B',
        }}>
          {t('What’s flowing.', 'Cómo va el dinero.')}
        </h1>
        <p style={{
          fontSize: 17, lineHeight: 1.55, color: '#52525B',
          margin: '18px 0 0', maxWidth: 620,
        }}>
          {t(
            'Revenue, expenses, labor, and inventory spend — pulled together for the last seven days.',
            'Ingresos, gastos, mano de obra e inventario — juntos para los últimos siete días.'
          )}
        </p>
      </div>

      {/* Four-cell strip */}
      <section style={{
        marginBottom: 24,
        borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
        display: 'flex',
      }}>
        <Cell label={t('Revenue', 'Ingresos')} value={fmt(revenue7d)} accent="green" isFirst />
        <Cell label={t('Expenses', 'Gastos')} value={fmt(expenseTotal7d)} accent="red" />
        <Cell label={t('Labor est.', 'M. de obra')} value={fmt(laborEstimate7d)} accent="red" />
        <Cell label={t('Inventory', 'Inventario')} value={fmt(inventorySpend7d)} accent="amber" />
      </section>

      {/* Net for the period */}
      <section style={{
        marginBottom: 56,
        borderBottom: '1px solid #E7E6E2',
        padding: '20px 20px 22px',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 18 }}>
          <div style={eyebrow}>{t('Net for the period', 'Utilidad del período')}</div>
          <div style={mono({
            fontSize: 28, fontWeight: 600, lineHeight: 1,
            color: net >= 0 ? '#15803D' : '#B91C1C',
          })}>
            {net >= 0 ? '+' : ''}{fmt(net)}
          </div>
        </div>
        <p style={{ fontSize: 12.5, color: '#9CA3AF', margin: '8px 0 0', maxWidth: 520 }}>
          {t(
            'Revenue minus expenses + scheduled labor estimate. Inventory spend is included in expenses where flagged.',
            'Ingresos menos gastos + costo estimado de mano de obra. El gasto de inventario se incluye en gastos cuando está marcado.'
          )}
        </p>
      </section>

      {/* Recent expenses */}
      <section>
        <h2 style={{
          fontSize: 'clamp(22px, 2.4vw, 28px)', lineHeight: 1.1,
          letterSpacing: '-0.6px', fontWeight: 700, margin: '0 0 16px', color: '#18181B',
        }}>
          {t('Recent expenses', 'Gastos recientes')}{' '}
          <span style={mono({ fontSize: 16, fontWeight: 500, color: '#9CA3AF' })}>
            {recentExpenses.length}
          </span>
        </h2>
        {recentExpenses.length === 0 ? (
          <div style={{
            borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
            padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14,
          }}>
            {t('No expenses logged yet.', 'Aún sin gastos registrados.')}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {recentExpenses.map((e, idx) => (
              <li key={e.id} style={{
                borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                borderBottom: '1px solid #E7E6E2',
                padding: '14px 0',
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, auto)',
                gap: 18, alignItems: 'center',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#18181B' }}>
                    {e.vendorName ?? e.category}
                  </div>
                  {e.notes && (
                    <div style={mono({ fontSize: 11, color: '#9CA3AF', marginTop: 3 })}>
                      {e.notes}
                    </div>
                  )}
                </div>
                <div style={mono({ fontSize: 12, color: '#52525B' })}>{e.category}</div>
                <div style={mono({ fontSize: 14, fontWeight: 600, color: '#18181B', textAlign: 'right' })}>
                  {fmt(e.amount)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid #E7E6E2' }}>
        <p style={{ fontSize: 14, color: '#9CA3AF', margin: 0 }}>
          {t('Need to log an expense, connect a bank, or review bank transactions?', '¿Necesitas registrar un gasto, conectar un banco o revisar transacciones?')}{' '}
          <Link href="/finance" style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
            {t('Open the classic finance workspace', 'Abre el espacio clásico de finanzas')}
          </Link>.
        </p>
      </div>
    </div>
  )
}

function Cell({
  label, value, accent = 'ink', isFirst,
}: {
  label: string; value: string
  accent?: 'ink' | 'green' | 'red' | 'amber'
  isFirst?: boolean
}) {
  const color =
    accent === 'green' ? '#15803D' :
    accent === 'red'   ? '#B91C1C' :
    accent === 'amber' ? '#B45309' :
    '#18181B'
  return (
    <div style={{
      flex: 1, padding: '18px 20px',
      borderLeft: isFirst ? 'none' : '1px solid #E7E6E2',
    }}>
      <div style={eyebrow}>{label}</div>
      <div style={mono({ fontSize: 22, fontWeight: 600, lineHeight: 1, color, marginTop: 10 })}>
        {value}
      </div>
    </div>
  )
}
