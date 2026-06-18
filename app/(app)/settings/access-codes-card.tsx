'use client'

// ----------------------------------------------------------------
// AccessCodesCard — owner sets the device-level passcodes that
// gate the system. See app/actions/access.ts for the full flow:
//
//   • owner code unlocks the full system
//   • staff code pins the device to /pos
//   • sign-out requires the owner code (no exceptions)
//
// We never display the current codes — only whether they're set.
// The hashes sit on `restaurants` behind RLS but we don't surface
// them in the UI either. Leaving an input blank means "keep the
// current code"; the explicit "Disable staff mode" button is the
// only way to clear a code without setting a new one.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import { setPasscodes, clearStaffPasscode } from '@/app/actions/access'

interface Props {
  ownerSet: boolean
  staffSet: boolean
}

export default function AccessCodesCard({ ownerSet, staffSet }: Props) {
  const [state, formAction, pending] = useActionState(setPasscodes, null)

  return (
    <div className="bg-white border border-zinc-200 rounded-2xl p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-base font-semibold text-zinc-900">Access codes</h2>
        <span className="text-xs font-mono uppercase tracking-wider text-zinc-400">
          Kiosk mode
        </span>
      </div>
      <p className="text-sm text-zinc-500 mb-5 leading-relaxed">
        A short 4-digit code controls who sees what on this device. The owner code
        unlocks everything. The staff code locks the device to POS only — no
        finance, no inventory, no settings. Sign-out always requires the owner code.
      </p>

      <form action={formAction} className="space-y-4">
        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-zinc-500 mb-2">
            Owner code {ownerSet && <span className="text-emerald-600 normal-case font-sans">· set</span>}
          </label>
          <input
            name="owner_passcode"
            type="text"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            placeholder={ownerSet ? '••••  (keep current)' : '4 digits'}
            className="w-40 text-center text-lg tracking-[0.4em] font-mono py-2.5 px-3 rounded-lg border border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>

        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-zinc-500 mb-2">
            Staff code {staffSet && <span className="text-emerald-600 normal-case font-sans">· set</span>}
          </label>
          <input
            name="staff_passcode"
            type="text"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            placeholder={staffSet ? '••••  (keep current)' : '4 digits'}
            className="w-40 text-center text-lg tracking-[0.4em] font-mono py-2.5 px-3 rounded-lg border border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
          <p className="text-xs text-zinc-500 mt-2">
            Leave blank to keep the current code.
          </p>
        </div>

        {state?.error && (
          <div className="text-sm text-rose-600" role="alert">
            {state.error}
          </div>
        )}
        {state?.ok && !state.error && (
          <div className="text-sm text-emerald-600">Saved.</div>
        )}

        <button
          type="submit"
          disabled={pending}
          className="bg-zinc-900 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>

      {staffSet && (
        <form action={clearStaffPasscode} className="mt-3">
          <button
            type="submit"
            className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            Disable staff code
          </button>
        </form>
      )}
    </div>
  )
}
