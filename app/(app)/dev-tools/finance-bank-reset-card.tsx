'use client'

// ----------------------------------------------------------------
// Finance Bank Sandbox Reset — Dev Toolbox UI
//
// Dev-only client island. One destructive action that wipes ALL
// bank-side test state for this restaurant — every Plaid-imported
// or sandbox-seeded bank_transactions row, every Bank Review
// decision attached to those rows (review_state, settled_kind,
// settled_expense_id, settled_at), and the sync cursors on each
// connected_bank_accounts row so the next sync starts fresh.
//
// Intentionally preserved so the manager doesn't have to rebuild
// the world to test Finance again:
//
//   • Plaid access tokens (bank_provider_secrets)
//   • Connected account rows themselves
//   • Sales / POS orders / inventory / staffing / menu / employees
//   • Business / location / user setup
//
// Two-step confirmation in-card — clicking "Reset bank sandbox"
// switches the button into "Are you sure?" mode; only the second
// click invokes the server action. Avoids the platform-native
// confirm() dialog so the destructive copy stays consistent with
// the rest of the Dev Toolbox design.
// ----------------------------------------------------------------

import { useState, useTransition } from 'react'
import { resetFinanceBankSandbox } from '@/app/actions/bank'

type Result = { ok: true; message: string } | { error: string }

export default function FinanceBankResetCard() {
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [lastMessage, setLastMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  function runReset() {
    setConfirming(false)
    startTransition(async () => {
      const res = (await resetFinanceBankSandbox(null, new FormData())) as Result
      if ('error' in res) setLastMessage({ kind: 'error', text: res.error })
      else setLastMessage({ kind: 'ok', text: res.message })
    })
  }

  return (
    <div className="rounded-xl border border-red-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
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

      <p className="text-sm font-semibold text-gray-900">Reset Finance Bank Sandbox</p>
      <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
        Deletes every imported bank transaction and its Bank Review decision
        for this restaurant. Plaid sync cursors are intentionally{' '}
        <strong>preserved</strong> so the next auto-sync won&apos;t replay the
        historical activity you just wiped. To also have Plaid redeliver
        history, disconnect and reconnect the bank in Settings.
      </p>

      {/* What clears / what stays — explicit so the manager knows the
          blast radius before confirming. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-red-100 bg-red-50/40 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-red-700">
            Cleared
          </p>
          <ul className="mt-1.5 text-[11px] text-red-800/90 leading-relaxed space-y-0.5 list-disc pl-4">
            <li>bank_transactions (every row, restaurant-scoped)</li>
            <li>review_state / settled_kind / settled_at / settled_expense_id (columns on those rows)</li>
          </ul>
        </div>
        <div className="rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700">
            Preserved
          </p>
          <ul className="mt-1.5 text-[11px] text-emerald-900/90 leading-relaxed space-y-0.5 list-disc pl-4">
            <li>Plaid access tokens (bank_provider_secrets)</li>
            <li>Connected account rows + last_sync_cursor + last_synced_at</li>
            <li>Sales / orders / inventory / staffing / menu / employees</li>
            <li>Business + location + user setup</li>
          </ul>
        </div>
      </div>

      {/* Action row */}
      <div className="mt-4 flex items-center gap-2">
        {!confirming ? (
          <button
            type="button"
            onClick={() => {
              setConfirming(true)
              setLastMessage(null)
            }}
            disabled={pending}
            className="rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Resetting…' : 'Reset bank sandbox'}
          </button>
        ) : (
          <>
            <p className="text-[11px] text-red-700 leading-relaxed flex-1">
              Are you sure? This will delete imported bank/API transaction data and
              Bank Review test state. It will not delete sales, inventory, staffing,
              menu, or business setup.
            </p>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={runReset}
              className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
            >
              Yes, reset
            </button>
          </>
        )}
      </div>
    </div>
  )
}
