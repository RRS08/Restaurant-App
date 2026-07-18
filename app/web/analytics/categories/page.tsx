import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebAnalyticsCategoriesPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Analytics · Categories', 'Analíticas · Categorías')}
      title={t('Where the money came from.', 'De dónde vino el dinero.')}
      description={t(
        'Revenue and unit-volume mix by category, current vs prior period. Helps answer the "is our drinks share shrinking?" or "are sides growing?" questions without staring at every item individually.',
        'Mezcla de ingresos y unidades por categoría, actual vs anterior. Responde “¿está bajando la participación de bebidas?” o “¿están creciendo los acompañamientos?” sin revisar artículo por artículo.'
      )}
      classicHref="/analytics"
      classicCtaText={t(
        'For now, category-level analytics live in the',
        'Por ahora, el análisis por categoría vive en el'
      )}
      classicLinkLabel={t('classic analytics workspace', 'espacio clásico de analíticas')}
    />
  )
}
