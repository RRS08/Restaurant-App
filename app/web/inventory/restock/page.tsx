import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebInventoryRestockPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Inventory · Restock', 'Inventario · Reorden')}
      title={t('Order what you’re running out of.', 'Ordena lo que se está acabando.')}
      description={t(
        'Build a restock cart from your low items, choose a vendor, place the order, mark it received when it lands. Stock flows back into the Overview automatically as receipts close.',
        'Arma un carrito de reorden desde lo que está bajo, elige proveedor, coloca la orden y márcala recibida cuando llegue. El stock vuelve al resumen automáticamente al cerrar los pedidos.'
      )}
      classicHref="/inventory"
      classicCtaText={t(
        'For now, place restock orders in the',
        'Por ahora, haz pedidos en el'
      )}
      classicLinkLabel={t('classic inventory workspace', 'espacio clásico de inventario')}
    />
  )
}
