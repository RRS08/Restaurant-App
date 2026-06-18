'use client'

// ----------------------------------------------------------------
// AccessForm — tap-first 4-digit numpad.
//
// Built for the floor: a real cashier handing the iPad to a server
// doesn't want to fight the on-screen keyboard. We render a calm
// 3-column numpad with big tap targets, a 4-dot progress indicator,
// and a backspace key. Auto-submits on the 4th digit so there's no
// "now hit Enter" step.
//
// Hardware keyboard still works as a fallback (number keys append,
// Backspace removes, Enter submits) — useful on desktop testing
// and for accessibility. We sync the keyboard handler to the same
// state, so the dot indicator stays accurate either way.
//
// Two action targets depending on mode:
//   • default → enterAccessMode (validates and sets pos_mode cookie)
//   • signout → signOutWithPasscode (verifies owner code, signs out)
// ----------------------------------------------------------------

import { useActionState, useEffect, useRef, useState } from 'react'
import { enterAccessMode, signOutWithPasscode } from '@/app/actions/access'
import { makeT, type Lang } from '@/lib/i18n'

interface Props {
  signout: boolean
  lang: Lang
}

export default function AccessForm({ signout, lang }: Props) {
  const t = makeT(lang)
  const action = signout ? signOutWithPasscode : enterAccessMode
  const [state, formAction, isPending] = useActionState(action, null)
  const formRef = useRef<HTMLFormElement>(null)
  const [digits, setDigits] = useState('')

  // Clear input on error so the user can re-enter without
  // backspacing through old digits.
  useEffect(() => {
    if (state?.error) setDigits('')
  }, [state?.error])

  // Keyboard fallback — number row + Backspace. Stays in sync with
  // the visual numpad state so the dots reflect what's actually
  // queued. Auto-submit on the 4th digit, same as the tap path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPending) return
      if (e.key >= '0' && e.key <= '9') {
        setDigits((d) => (d.length >= 4 ? d : d + e.key))
      } else if (e.key === 'Backspace') {
        setDigits((d) => d.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPending])

  // Auto-submit on the 4th digit. The hidden input value is set via
  // React, so requestSubmit() carries it through to the server action.
  useEffect(() => {
    if (digits.length === 4 && !isPending) {
      formRef.current?.requestSubmit()
    }
  }, [digits, isPending])

  const press = (d: string) => {
    if (isPending) return
    setDigits((cur) => (cur.length >= 4 ? cur : cur + d))
  }
  const backspace = () => {
    if (isPending) return
    setDigits((cur) => cur.slice(0, -1))
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-6">
      {/* 4-dot indicator. Filled = digit entered. Stays at 4 slots
          always so the user can see how many they have left. */}
      <div className="flex items-center justify-center gap-4 h-9">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={
              'w-3 h-3 rounded-full transition-all ' +
              (i < digits.length
                ? 'bg-gray-900 scale-100'
                : 'bg-gray-200 scale-90')
            }
            aria-hidden
          />
        ))}
      </div>

      {/* Hidden field — what the server action reads. The numpad
          controls its value via React state. */}
      <input type="hidden" name="passcode" value={digits} />

      {state?.error && (
        <p className="text-[13px] text-red-600 text-center" role="alert">
          {state.error}
        </p>
      )}

      {/* 3-column numpad. Big tap targets (h-16) tuned for fingers,
          not cursors. Active-state shrinks slightly so taps feel
          responsive on touch. */}
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => press(String(n))}
            disabled={isPending}
            className="h-16 rounded-xl bg-white border border-gray-200 text-2xl font-medium text-gray-900 hover:bg-gray-50 active:bg-gray-100 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {n}
          </button>
        ))}
        {/* Bottom row: blank slot, 0, backspace. The blank keeps the
            grid aligned without forcing the 0 to the left edge. */}
        <div aria-hidden />
        <button
          type="button"
          onClick={() => press('0')}
          disabled={isPending}
          className="h-16 rounded-xl bg-white border border-gray-200 text-2xl font-medium text-gray-900 hover:bg-gray-50 active:bg-gray-100 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          0
        </button>
        <button
          type="button"
          onClick={backspace}
          disabled={isPending || digits.length === 0}
          aria-label={t('Backspace', 'Borrar')}
          className="h-16 rounded-xl bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 active:bg-gray-100 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
            <line x1="18" y1="9" x2="12" y2="15" />
            <line x1="12" y1="9" x2="18" y2="15" />
          </svg>
        </button>
      </div>

      {isPending && (
        <p className="text-[12px] text-center text-gray-400 font-mono uppercase tracking-[0.12em]">
          {t('Checking…', 'Verificando…')}
        </p>
      )}
    </form>
  )
}
