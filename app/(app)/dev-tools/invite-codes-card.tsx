'use client'

// ----------------------------------------------------------------
// InviteCodesCard — dev-only invite code manager.
//
// Mint a code per pilot, hand it out, watch the consumption +
// expiry state. Codes are revocable from this card — useful when
// you sent the code to the wrong restaurant or want to retire an
// old pilot link.
//
// The actions sit in app/actions/invites.ts and all enforce
// isDevEmail() before touching the table.
// ----------------------------------------------------------------

import { useActionState, useEffect, useState, useTransition } from 'react'
import {
  createInviteCode,
  listInviteCodes,
  revokeInviteCode,
  type InviteCodeRow,
} from '@/app/actions/invites'

interface Props {
  initialCodes: InviteCodeRow[]
}

export default function InviteCodesCard({ initialCodes }: Props) {
  const [createState, createAction, creating] = useActionState(createInviteCode, null)
  const [codes, setCodes] = useState<InviteCodeRow[]>(initialCodes)
  const [pending, startTransition] = useTransition()
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  // Refresh the list after a successful create or a revoke so the
  // card stays in sync without a full page reload.
  const refresh = () => {
    startTransition(async () => {
      const { codes } = await listInviteCodes()
      setCodes(codes)
    })
  }

  useEffect(() => {
    if (createState?.code) refresh()
  }, [createState?.code])

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopiedCode(code)
    setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1500)
  }

  const handleRevoke = (id: string) => {
    if (!confirm('Revoke this code? It can no longer be used to sign up.')) return
    startTransition(async () => {
      await revokeInviteCode(id)
      refresh()
    })
  }

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700">
          Invite codes
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-600">
          Signup gate
        </p>
      </div>
      <p className="mt-1.5 text-base font-semibold text-gray-900">
        Mint a code per pilot, hand it out, watch the redemption.
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
        /signup is closed to the public — every new account must arrive with a code minted here.
        Generate one per pilot, send it via text or email after they’ve agreed to the pilot
        price, then revoke it if anything goes sideways.
      </p>

      {/* Create form */}
      <form action={createAction} className="mt-4 grid grid-cols-1 sm:grid-cols-[1fr_120px_120px_auto] gap-2 items-end">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">
            Notes
          </label>
          <input
            type="text"
            name="notes"
            placeholder="Pilot #1 — Tacos Don Pedro"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">
            Max uses
          </label>
          <input
            type="number"
            name="max_uses"
            min={1}
            defaultValue={1}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">
            Expires (days)
          </label>
          <input
            type="number"
            name="expires_in_days"
            min={0}
            placeholder="0 = never"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[38px]"
        >
          {creating ? 'Generating…' : 'Generate'}
        </button>
      </form>
      {createState?.error && (
        <p className="mt-2 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {createState.error}
        </p>
      )}
      {createState?.code && (
        <div className="mt-2 flex items-center gap-3 px-3 py-2 rounded-md bg-emerald-50 border border-emerald-200">
          <span className="text-[13px] text-emerald-800">
            New code: <span className="font-mono font-bold tracking-[0.16em]">{createState.code}</span>
          </span>
          <button
            type="button"
            onClick={() => handleCopy(createState.code!)}
            className="text-[12px] font-medium text-emerald-700 hover:text-emerald-900 underline underline-offset-2"
          >
            {copiedCode === createState.code ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {/* Existing codes */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700">
            Existing codes
          </p>
          <span className="text-[11px] text-gray-500">{codes.length} total</span>
        </div>
        {codes.length === 0 ? (
          <p className="text-[13px] text-gray-500 italic">No codes yet. Generate one above.</p>
        ) : (
          <div className="space-y-2">
            {codes.map((c) => (
              <div
                key={c.id}
                className={
                  'flex items-center justify-between gap-3 px-3 py-2 rounded-lg border ' +
                  (c.status === 'active'
                    ? 'border-emerald-200 bg-white'
                    : c.status === 'consumed'
                      ? 'border-gray-200 bg-gray-50/60'
                      : 'border-red-200 bg-red-50/40')
                }
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono font-bold text-sm tracking-[0.16em] text-gray-900">
                    {c.code}
                  </span>
                  <span
                    className={
                      'text-[10px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded ' +
                      (c.status === 'active'
                        ? 'bg-emerald-100 text-emerald-700'
                        : c.status === 'consumed'
                          ? 'bg-gray-200 text-gray-600'
                          : 'bg-red-100 text-red-700')
                    }
                  >
                    {c.status}
                  </span>
                  <span className="text-[11px] font-mono text-gray-400 truncate">
                    {c.usedCount}/{c.maxUses}
                  </span>
                  {c.notes && (
                    <span className="text-[12px] text-gray-600 truncate min-w-0">
                      · {c.notes}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleCopy(c.code)}
                    disabled={pending}
                    className="text-[12px] font-medium text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-60"
                  >
                    {copiedCode === c.code ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRevoke(c.id)}
                    disabled={pending}
                    className="text-[12px] text-gray-500 hover:text-red-700 transition-colors disabled:opacity-60"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
