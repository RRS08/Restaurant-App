// ----------------------------------------------------------------
// New Category Page  →  /menu/new-category
//
// A simple form that creates a menu_categories row.
// Uses the same useActionState pattern as login/signup/onboarding.
//
// After successful creation, the server action redirects to /menu.
// ----------------------------------------------------------------

import { getLang } from '@/lib/i18n-server'
import NewCategoryForm from './form'

export default async function NewCategoryPage() {
  const lang = await getLang()
  return <NewCategoryForm lang={lang} />
}
