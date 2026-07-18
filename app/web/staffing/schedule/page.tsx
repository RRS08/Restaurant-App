import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebStaffingSchedulePage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Staffing · Schedule', 'Personal · Horario')}
      title={t('Build the week.', 'Arma la semana.')}
      description={t(
        'Lay out every shift for the upcoming week — by section, by role, by employee. The Overview shows today; the Schedule is where you do the planning.',
        'Distribuye cada turno de la semana — por sección, por rol, por persona. El resumen es hoy; el horario es donde haces la planeación.'
      )}
      classicHref="/staffing"
      classicCtaText={t(
        'For now, build the schedule in the',
        'Por ahora, arma el horario en el'
      )}
      classicLinkLabel={t('classic staffing workspace', 'espacio clásico de personal')}
    />
  )
}
