import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebFinanceBankPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Finance · Bank', 'Finanzas · Banco')}
      title={t('Connect, review, reconcile.', 'Conecta, revisa, concilia.')}
      description={t(
        'Plaid-connected accounts on one side, the review queue on the other. Settle uncategorized outflows, ignore noise, match deposits against revenue. Anything related to money moving in or out of your bank lives here.',
        'Cuentas conectadas con Plaid de un lado, cola de revisión del otro. Conlcuye salidas sin categorizar, ignora ruido, concilia depósitos contra ingresos. Todo lo que mueve dinero en tu banco vive aquí.'
      )}
      classicHref="/finance"
      classicCtaText={t(
        'For now, review bank transactions in the',
        'Por ahora, revisa transacciones del banco en el'
      )}
      classicLinkLabel={t('classic finance workspace', 'espacio clásico de finanzas')}
    />
  )
}
