// ----------------------------------------------------------------
// New Inventory Count Page  →  /inventory/new-count
//
// Server Component: fetches inventory items for the dropdown.
// Passes them to the Client Component form.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import NewCountForm from './form'

export default async function NewCountPage() {
  const supabase = await createClient()

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure')
    .eq('active', true)
    .order('name', { ascending: true })

  return (
    <div className="max-w-md">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Record inventory count</h1>
        <p className="mt-1 text-sm text-gray-500">
          Enter the actual quantity on hand after a physical count.
        </p>
      </div>

      <NewCountForm items={items ?? []} />
    </div>
  )
}
