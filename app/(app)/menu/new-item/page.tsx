// ----------------------------------------------------------------
// New Menu Item Page  →  /menu/new-item
//
// This page has TWO parts:
//   1. A Server Component (this file) that fetches category options
//      from the database — we need them for the <select> dropdown.
//   2. A Client Component (NewItemForm below) that handles the
//      interactive form with useActionState.
//
// We can't fetch categories inside the Client Component because
// Client Components run in the browser and can't call the server
// Supabase client directly. So the Server Component fetches, and
// passes the data down as props.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import NewItemForm from './form'

export default async function NewItemPage() {
  const supabase = await createClient()

  // Fetch categories for the dropdown.
  // RLS filters to the current user's restaurant automatically.
  const { data: categories } = await supabase
    .from('menu_categories')
    .select('id, name')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  return (
    <div className="max-w-md">

      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">New menu item</h1>
        <p className="mt-1 text-sm text-gray-500">
          Add a dish, drink, or product to your menu.
        </p>
      </div>

      {/* The form is a Client Component — it handles useActionState */}
      <NewItemForm categories={categories ?? []} />

    </div>
  )
}
