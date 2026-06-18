// ----------------------------------------------------------------
// New Inventory Item Page  →  /inventory/new-item
//
// Server Component: reads the device language and renders the
// client-side form so we can interpolate translations without
// pulling next/headers into the form's client bundle.
// ----------------------------------------------------------------

import { getT, getLang } from '@/lib/i18n-server'
import NewInventoryItemForm from './form'

export default async function NewInventoryItemPage() {
  const t = await getT()
  const lang = await getLang()

  return (
    <div className="max-w-md">

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t('New inventory item', 'Nuevo artículo de inventario')}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('Add an ingredient or product you want to track stock for.', 'Agrega un ingrediente o producto del que quieras rastrear stock.')}
        </p>
      </div>

      <NewInventoryItemForm lang={lang} />

    </div>
  )
}
