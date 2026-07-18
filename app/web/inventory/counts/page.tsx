import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebInventoryCountsPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Inventory · Counts', 'Inventario · Conteos')}
      title={t('Take a count.', 'Toma un conteo.')}
      description={t(
        'Record a physical count for any item, review every count taken in the past, and watch how the estimated stock corrects itself afterward. This page is where the "Estimated" number on Overview comes from.',
        'Registra un conteo físico de cualquier artículo, revisa cada conteo pasado y mira cómo el estimado se corrige después. De aquí sale el “Estimado” que ves en el resumen.'
      )}
      classicHref="/inventory"
      classicCtaText={t(
        'For now, record counts in the',
        'Por ahora, registra conteos en el'
      )}
      classicLinkLabel={t('classic inventory workspace', 'espacio clásico de inventario')}
    />
  )
}
