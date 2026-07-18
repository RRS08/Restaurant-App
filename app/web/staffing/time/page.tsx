import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebStaffingTimePage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Staffing · Time', 'Personal · Tiempo')}
      title={t('Who clocked in, who clocked out.', 'Quién entró, quién salió.')}
      description={t(
        'Live time-clock state for everyone scheduled today, with break tracking and end-of-shift totals. Hours collected here feed into Payroll automatically.',
        'Estado en vivo del reloj para todos los que están programados hoy, con seguimiento de descansos y totales de fin de turno. Las horas aquí alimentan la nómina automáticamente.'
      )}
    />
  )
}
