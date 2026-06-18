// ----------------------------------------------------------------
// Login Page  →  /login
//
// Server component. Reads the lang cookie and hands it to the
// client form below. The actual login logic runs on the server
// inside app/actions/auth.ts.
//
// The form will work even if JavaScript fails to load (progressive
// enhancement), because the action is a server action on a real <form>.
// ----------------------------------------------------------------

import { getLang } from '@/lib/i18n-server'
import LoginForm from './form'

export default async function LoginPage() {
  const lang = await getLang()
  return <LoginForm lang={lang} />
}
