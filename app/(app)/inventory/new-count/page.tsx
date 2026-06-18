// ----------------------------------------------------------------
// New Inventory Count Page  →  /inventory/new-count
//
// Server Component: fetches inventory items for the dropdown.
// Passes them to the Client Component form.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getT, getLang } from '@/lib/i18n-server'
import NewCountForm from './form'

export default async function NewCountPage() {
  const supabase = await createClient()
  const t = await getT()
  const lang = await getLang()

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure')
    .eq('active', true)
    .order('name', { ascending: true })

  return (
    <div className="max-w-md">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t('Record inventory count', 'Registrar conteo de inventario')}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('Enter the actual quantity on hand after a physical count.', 'Ingresa la cantidad real disponible después de un conteo físico.')}
        </p>
      </div>

      <NewCountForm items={items ?? []} lang={lang} />
    </div>
  )
}
