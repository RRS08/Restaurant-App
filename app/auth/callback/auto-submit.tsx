'use client'

// ----------------------------------------------------------------
// AutoSubmit — invisible client island that submits the callback
// form as soon as the page mounts in a real browser.
//
// Combined with the server-side form on /auth/callback, this
// eliminates the visible "Continue" click while still keeping
// scanner-safety: link scanners like Outlook Safe Links don't
// run JS on prefetch, so useEffect never fires for them and the
// token stays intact for the real user.
//
// Small window (~300 ms) where the "Continuing…" copy is visible
// before the redirect. Users on JS-disabled browsers see the
// fallback button that stays in the form.
// ----------------------------------------------------------------

import { useEffect, useRef } from 'react'

export default function AutoSubmit({ formId }: { formId: string }) {
  // A ref-less guard so double-mount in strict mode doesn't submit twice.
  // The server action redirects anyway, but avoiding a second POST is
  // cheap insurance against any unexpected re-execution.
  const submitted = useRef(false)

  useEffect(() => {
    if (submitted.current) return
    const form = document.getElementById(formId)
    if (!form || !(form instanceof HTMLFormElement)) return
    submitted.current = true
    form.requestSubmit()
  }, [formId])

  return null
}
