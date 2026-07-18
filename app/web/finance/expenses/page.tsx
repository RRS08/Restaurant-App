import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebFinanceExpensesPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Finance · Expenses', 'Finanzas · Gastos')}
      title={t('Log what you spent.', 'Registra lo que gastaste.')}
      description={t(
        'Add any non-payroll, non-inventory spend — rent, utilities, supplies, subscriptions. Edit, recategorize, or split lines across categories. Drives the Expenses cell on the Overview.',
        'Captura cualquier gasto fuera de nómina e inventario — renta, servicios, insumos, suscripciones. Edita, recategoriza o divide líneas. Alimenta la celda de Gastos en el resumen.'
      )}
      classicHref="/finance"
      classicCtaText={t(
        'For now, log expenses in the',
        'Por ahora, registra gastos en el'
      )}
      classicLinkLabel={t('classic finance workspace', 'espacio clásico de finanzas')}
    />
  )
}
