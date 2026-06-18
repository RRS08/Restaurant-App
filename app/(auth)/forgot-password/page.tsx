// ----------------------------------------------------------------
// Forgot Password Page  →  /forgot-password
//
// Server component that reads the lang cookie and renders the
// client form. The actual flow lives in form.tsx.
// ----------------------------------------------------------------

import { getLang } from '@/lib/i18n-server'
import ForgotPasswordForm from './form'

export default async function ForgotPasswordPage() {
  const lang = await getLang()
  return <ForgotPasswordForm lang={lang} />
}
