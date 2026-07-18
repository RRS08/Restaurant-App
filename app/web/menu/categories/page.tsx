import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebMenuCategoriesPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Menu · Categories', 'Menú · Categorías')}
      title={t('Shape the menu.', 'Dale forma al menú.')}
      description={t(
        'Rename, reorder, add, or archive the sections customers see. Items move between categories from the Overview; this page is where the categories themselves get organized.',
        'Renombra, reordena, agrega o archiva las secciones que ve el cliente. Los artículos se mueven entre categorías desde el resumen; aquí organizas las categorías mismas.'
      )}
      classicHref="/menu"
      classicCtaText={t(
        'For now, manage categories in the',
        'Por ahora, gestiona las categorías en el'
      )}
      classicLinkLabel={t('classic menu workspace', 'espacio clásico del menú')}
    />
  )
}
