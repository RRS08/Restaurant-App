// ----------------------------------------------------------------
// New Inventory Transaction Page  →  /inventory/new-transaction
//
// Server Component: fetches inventory items for the dropdown.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getT, getLang } from '@/lib/i18n-server'
import NewTransactionForm from './form'

export default async function NewTransactionPage() {
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
        <h1 className="text-2xl font-bold text-gray-900">{t('Log transaction', 'Registrar movimiento')}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('Record a purchase, waste event, or stock adjustment.', 'Registra una compra, desperdicio o ajuste de stock.')}
        </p>
      </div>

      <NewTransactionForm items={items ?? []} lang={lang} />
    </div>
  )
}
