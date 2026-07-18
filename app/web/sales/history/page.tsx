import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebSalesHistoryPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Sales · History', 'Ventas · Historial')}
      title={t('The longer look.', 'La vista más amplia.')}
      description={t(
        'Search across every order on file, filter by source or payment, jump to any day. The overview shows today; History is where you go to find that one order from last week.',
        'Busca cualquier orden, filtra por origen o pago, salta a cualquier día. El resumen muestra hoy; el historial es donde encuentras esa orden de la semana pasada.'
      )}
      classicHref="/sales"
      classicCtaText={t(
        'For now, look up old orders in the',
        'Por ahora, busca órdenes antiguas en el'
      )}
      classicLinkLabel={t('classic sales workspace', 'espacio clásico de ventas')}
    />
  )
}
