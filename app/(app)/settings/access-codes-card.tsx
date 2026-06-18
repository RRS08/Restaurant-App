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
// current code"; the explicit "Disable staff code" button is the
// only way to clear a code without setting a new one.
//
// Chrome matches the other Settings cards (BusinessCard,
// OperationsCard, etc.) — same rounded-xl + soft shadow, same
// eyebrow type, same gray-* palette — so the page reads as one
// surface, not a patchwork.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import { setPasscodes, clearStaffPasscode, lockDevice } from '@/app/actions/access'

interface Props {
  ownerSet: boolean
  staffSet: boolean
}

export default function AccessCodesCard({ ownerSet, staffSet }: Props) {
  const [state, formAction, pending] = useActionState(setPasscodes, null)

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
          Access codes
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          Kiosk mode
        </p>
      </div>
      <p className="mt-1.5 text-base font-semibold text-gray-900">
        Lock the floor to POS only.
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
        A short 4-digit code controls who sees what on this device. The owner code
        unlocks everything. The staff code locks the device to POS — no finance,
        no inventory, no settings. Sign-out always requires the owner code.
      </p>

      <form action={formAction} className="mt-4 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500 mb-1.5">
              Owner code
              {ownerSet && (
                <span className="ml-1.5 normal-case font-normal tracking-normal text-emerald-600">
                  · set
                </span>
              )}
            </label>
            <input
              name="owner_passcode"
              type="text"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              placeholder={ownerSet ? '••••' : '4 digits'}
              className="w-32 text-center text-base tracking-[0.4em] font-mono py-2 px-2 rounded-lg border border-gray-300 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500 mb-1.5">
              Staff code
              {staffSet && (
                <span className="ml-1.5 normal-case font-normal tracking-normal text-emerald-600">
                  · set
                </span>
              )}
            </label>
            <input
              name="staff_passcode"
              type="text"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              placeholder={staffSet ? '••••' : '4 digits'}
              className="w-32 text-center text-base tracking-[0.4em] font-mono py-2 px-2 rounded-lg border border-gray-300 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
        <p className="text-[11px] text-gray-500">
          Leave a field blank to keep its current code.
        </p>

        {state?.error && (
          <p className="text-[13px] text-red-600" role="alert">
            {state.error}
          </p>
        )}
        {state?.ok && !state.error && (
          <p className="text-[13px] text-emerald-600">Saved.</p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>

      {(ownerSet || staffSet) && (
        <div className="mt-4 pt-3 border-t border-gray-100 flex items-center gap-5 flex-wrap">
          {ownerSet && (
            <form action={lockDevice}>
              <button
                type="submit"
                className="text-[13px] font-medium text-gray-900 hover:text-gray-600 transition-colors"
              >
                Lock device now →
              </button>
            </form>
          )}
          {staffSet && (
            <form action={clearStaffPasscode}>
              <button
                type="submit"
                className="text-[13px] text-gray-500 hover:text-gray-900 transition-colors"
              >
                Disable staff code
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  )
}
