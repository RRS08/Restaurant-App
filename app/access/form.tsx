'use client'

// ----------------------------------------------------------------
// AccessForm — 4-digit passcode entry.
//
// Two action targets depending on mode:
//   • default → enterAccessMode (validates and sets pos_mode cookie)
//   • signout → signOutWithPasscode (verifies owner code, signs out)
//
// The input is numeric and constrained to 4 chars; the form submits
// on the 4th digit automatically so floor staff don't have to hunt
// for an Enter key on the on-screen keyboard.
// ----------------------------------------------------------------

import { useActionState, useEffect, useRef } from 'react'
import { enterAccessMode, signOutWithPasscode } from '@/app/actions/access'

interface Props {
  signout: boolean
}

export default function AccessForm({ signout }: Props) {
  const action = signout ? signOutWithPasscode : enterAccessMode
  const [state, formAction, isPending] = useActionState(action, null)
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Autofocus on mount so the on-screen keyboard pops on mobile
  // without an extra tap.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Auto-submit on the 4th digit. Floor UX: no second tap to confirm.
  const handleInput = (e: React.FormEvent<HTMLInputElement>) => {
    const v = e.currentTarget.value.replace(/\D/g, '').slice(0, 4)
    e.currentTarget.value = v
    if (v.length === 4) {
      formRef.current?.requestSubmit()
    }
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-5">
      <div>
        <label
          htmlFor="passcode"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          4-digit code
        </label>
        <input
          ref={inputRef}
          id="passcode"
          name="passcode"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{4}"
          maxLength={4}
          onInput={handleInput}
          disabled={isPending}
          placeholder="••••"
          aria-label="Passcode"
          className="w-full text-center text-3xl tracking-[0.6em] font-mono py-4 rounded-lg border border-gray-300 bg-white placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-60"
        />
      </div>

      {state?.error && (
        <div className="text-sm text-red-600 text-center" role="alert">
          {state.error}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isPending ? 'Checking…' : signout ? 'Sign out' : 'Enter'}
      </button>
    </form>
  )
}
