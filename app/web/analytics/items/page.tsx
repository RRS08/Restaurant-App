import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebAnalyticsItemsPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Analytics · Items', 'Analíticas · Artículos')}
      title={t('What’s selling, what’s slipping.', 'Qué se vende, qué baja.')}
      description={t(
        'Every menu item ranked by revenue and growth — current period vs the prior one. Find your hidden hits, spot the items quietly dying, and decide what to push or drop.',
        'Cada artículo del menú ordenado por ingresos y crecimiento — período actual vs anterior. Encuentra los hits ocultos, detecta lo que muere en silencio, y decide qué empujar o quitar.'
      )}
      classicHref="/analytics"
      classicCtaText={t(
        'For now, item-level analytics live in the',
        'Por ahora, el análisis por artículo vive en el'
      )}
      classicLinkLabel={t('classic analytics workspace', 'espacio clásico de analíticas')}
    />
  )
}
