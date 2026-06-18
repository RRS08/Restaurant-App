// ----------------------------------------------------------------
// Reset Password Page  →  /reset-password
//
// Server component that reads the lang cookie and renders the
// client form (step 2 of the password-reset flow).
// ----------------------------------------------------------------

import { getLang } from '@/lib/i18n-server'
import ResetPasswordForm from './form'

export default async function ResetPasswordPage() {
  const lang = await getLang()
  return <ResetPasswordForm lang={lang} />
}
