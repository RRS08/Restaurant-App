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
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <input
        ref={inputRef}
        name="passcode"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{4}"
        maxLength={4}
        onInput={handleInput}
        disabled={isPending}
        className="w-full text-center text-3xl tracking-[0.6em] font-mono py-4 px-3 rounded-xl border border-zinc-300 bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 disabled:opacity-60"
        placeholder="••••"
        aria-label="Passcode"
      />
      {state?.error && (
        <div className="text-sm text-rose-600 text-center" role="alert">
          {state.error}
        </div>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="w-full bg-zinc-900 text-white font-medium py-3 rounded-xl hover:bg-zinc-800 transition-colors disabled:opacity-60"
      >
        {isPending ? 'Checking…' : signout ? 'Sign out' : 'Enter'}
      </button>
    </form>
  )
}
