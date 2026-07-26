'use client'

// ----------------------------------------------------------------
// AutoSubmit — invisible client island that submits the callback
// form as soon as the page mounts in a real browser.
//
// Password reset no longer routes through /auth/callback (that
// flow lands directly on /reset-password and does the code
// exchange on form submit). The remaining consumer is the
// invite acceptance flow (see app/actions/team.ts), which still
// needs a session established before /auth/accept-invite runs.
//
// Link scanners like Outlook Safe Links don't run JS on prefetch,
// so useEffect never fires for them and the token stays intact
// for the real user's tap.
// ----------------------------------------------------------------

import { useEffect, useRef } from 'react'

export default function AutoSubmit({ formId }: { formId: string }) {
  // Guard against strict-mode double-mount submitting twice; the
  // server action redirects on success anyway.
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
