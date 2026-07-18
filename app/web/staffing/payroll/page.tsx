import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebStaffingPayrollPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Staffing · Payroll', 'Personal · Nómina')}
      title={t('Calculate, report, pay.', 'Calcula, reporta, paga.')}
      description={t(
        'Pay-period summary per employee — hours, gross, withholdings, net — ready to fund or export. Phase 1 handles the calculation and reporting; tax remittance and direct deposit ship in later phases.',
        'Resumen del período de pago por persona — horas, bruto, retenciones, neto — listo para pagar o exportar. La fase 1 calcula y reporta; remesas de impuestos y depósito directo vienen después.'
      )}
    />
  )
}
