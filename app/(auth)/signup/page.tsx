// ----------------------------------------------------------------
// Signup Page  →  /signup
//
// Server component. Reads the lang cookie and hands it to the
// client form. The form collects full name, email, and password
// and calls the `signup` server action, which:
//   1. Creates the auth.users row via Supabase Auth
//   2. The DB trigger automatically creates the profiles row
//   3. Redirects to /onboarding
// ----------------------------------------------------------------

import { getLang } from '@/lib/i18n-server'
import SignupForm from './form'

export default async function SignupPage() {
  const lang = await getLang()
  return <SignupForm lang={lang} />
}
