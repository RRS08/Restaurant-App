'use client'

// ----------------------------------------------------------------
// Finance Settlement Sandbox — Dev Toolbox UI
//
// Dev-only client island. Seven scenario buttons + a "demo set" +
// a clear-test-data button. Each button calls a server action via
// useTransition so the page revalidates and new sandbox rows
// appear in /finance Bank Review on the next render.
//
// Real Plaid sandbox data is unreliable for end-to-end review
// testing (the dynamic-transactions profile is messy and lacks the
// merchant patterns the matcher expects). These deterministic
// seeds give the QA path a known surface to operate on.
// ----------------------------------------------------------------

import { useState, useTransition } from 'react'
import {
  seedSandboxBankTransactions,
  clearSandboxBankTransactions,
} from '@/app/actions/bank'

type Result = { ok: true; message: string } | { error: string }

interface Scenario {
  key: string
  label: string
  blurb: string
  expectedQueue: string
}

const SCENARIOS: Scenario[] = [
  {
    key: 'revenue',
    label: 'Seed revenue payout match',
    blurb: 'Incoming Stripe-style payout that should suggest "Settle as Revenue".',
    expectedQueue: 'Suggested matches → Settle as revenue',
  },
  {
    key: 'inventory',
    label: 'Seed inventory purchase match',
    blurb: 'Outgoing Sysco-style charge that should suggest "Settle as Inventory".',
    expectedQueue: 'Suggested matches → Settle as inventory',
  },
  {
    key: 'payroll',
    label: 'Seed payroll match',
    blurb: 'Outgoing ADP payroll line that should suggest "Settle as Labor".',
    expectedQueue: 'Suggested matches / Outgoing → Settle as labor',
  },
  {
    key: 'operating',
    label: 'Seed operating expense',
    blurb: 'Outgoing rent payment that should suggest "Settle as Operating".',
    expectedQueue: 'Suggested matches → Settle as operating',
  },
  {
    key: 'personal',
    label: 'Seed personal transaction',
    blurb: 'Outgoing CVS pharmacy charge tagged as personal — test the Ignore flow.',
    expectedQueue: 'Outgoing money → Ignore as personal',
  },
  {
    key: 'cash',
    label: 'Seed cash deposit',
    blurb: 'Incoming uncategorized deposit — should land in the Incoming queue.',
    expectedQueue: 'Incoming money → manager decides',
  },
  {
    key: 'unmatched',
    label: 'Seed unmatched activity',
    blurb: 'One ambiguous incoming + one ambiguous outgoing — neither matches a pattern.',
    expectedQueue: 'Incoming + Outgoing → unclear',
  },
  {
    key: 'demo',
    label: 'Seed full demo set',
    blurb: 'Runs every scenario above. Useful for taking the workflow on a full lap.',
    expectedQueue: 'A mix across every queue + likely suggestions',
  },
]

export default function FinanceSandboxCard() {
  const [pending, startTransition] = useTransition()
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [lastMessage, setLastMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  function runSeed(key: string) {
    setActiveKey(key)
    startTransition(async () => {
      const fd = new FormData()
      fd.append('scenario', key)
      const res = (await seedSandboxBankTransactions(null, fd)) as Result
      if ('error' in res) setLastMessage({ kind: 'error', text: res.error })
      else setLastMessage({ kind: 'ok', text: res.message })
      setActiveKey(null)
    })
  }

  function runClear() {
    setActiveKey('clear')
    startTransition(async () => {
      const res = (await clearSandboxBankTransactions(null, new FormData())) as Result
      if ('error' in res) setLastMessage({ kind: 'error', text: res.error })
      else setLastMessage({ kind: 'ok', text: res.message })
      setActiveKey(null)
    })
  }

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      {/* Status line */}
      {lastMessage && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 ${
            lastMessage.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          <p className="text-xs leading-relaxed">{lastMessage.text}</p>
        </div>
      )}

      {/* Scenario grid */}
      <div className="grid gap-3 md:grid-cols-2">
        {SCENARIOS.map((s) => {
          const isActive = pending && activeKey === s.key
          const isDemo = s.key === 'demo'
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => runSeed(s.key)}
              disabled={pending}
              className={`text-left rounded-lg border p-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                isDemo
                  ? 'border-blue-200 bg-blue-50/40 hover:bg-blue-50'
                  : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <p className={`text-[11px] font-semibold ${isDemo ? 'text-blue-900' : 'text-gray-900'}`}>
                {isActive ? 'Seeding…' : s.label}
              </p>
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">{s.blurb}</p>
              <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-gray-400">
                {s.expectedQueue}
              </p>
            </button>
          )
        })}
      </div>

      {/* Clear */}
      <div className="mt-5 pt-4 border-t border-gray-100">
        <button
          type="button"
          onClick={runClear}
          disabled={pending}
          className="rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {pending && activeKey === 'clear' ? 'Clearing…' : 'Clear sandbox bank transactions'}
        </button>
        <p className="mt-1.5 text-[10px] text-gray-500 leading-relaxed">
          Removes only rows whose <code className="px-1 bg-gray-100 rounded">provider_transaction_id</code>{' '}
          begins with <code className="px-1 bg-gray-100 rounded">sandbox_</code>. Real Plaid-imported
          rows are untouched.
        </p>
      </div>
    </div>
  )
}
