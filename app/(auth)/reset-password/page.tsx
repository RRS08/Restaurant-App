// ----------------------------------------------------------------
// Reset Password Page  →  /reset-password
//
// Server component that reads the lang cookie and renders the
// client form (step 2 of the password-reset flow).
//
// The email link now targets THIS page directly with a `?code=`
// query param — no /auth/callback stopover. We read that code
// server-side, hand it to the form as a prop, and the form
// carries it through as a hidden input. The `resetPassword`
// server action exchanges the code + writes the new password
// in one atomic submit, so link scanners can prefetch this
// page all they want without consuming the token.
//
// When landing here without a code (Settings → change password
// on an already-signed-in user), the form just skips the
// exchange and updates the password directly.
// ----------------------------------------------------------------

import { getLang } from '@/lib/i18n-server'
import ResetPasswordForm from './form'

interface Props {
  searchParams?: Promise<{ code?: string; error?: string; error_description?: string }>
}

export default async function ResetPasswordPage({ searchParams }: Props) {
  const lang = await getLang()
  const sp = (await searchParams) ?? {}
  const code = (sp.code ?? '').trim() || null
  return <ResetPasswordForm lang={lang} code={code} />
}
