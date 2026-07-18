import { PlaceholderPage } from '@/components/web/placeholder-page'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'

export default async function WebStaffingRosterPage() {
  const lang = await getLang()
  const t = makeT(lang)
  return (
    <PlaceholderPage
      eyebrowText={t('Staffing · Roster', 'Personal · Equipo')}
      title={t('Manage the team.', 'Gestiona al equipo.')}
      description={t(
        'Add new hires, retire departing employees, edit roles, set hourly rates, define sections. Anything that changes WHO is on the team — and what they do — happens here.',
        'Agrega contrataciones, retira salidas, edita roles, define tarifas, configura secciones. Aquí cambia QUIÉN está en el equipo y qué hace.'
      )}
      classicHref="/staffing"
      classicCtaText={t(
        'For now, manage the roster in the',
        'Por ahora, gestiona el equipo en el'
      )}
      classicLinkLabel={t('classic staffing workspace', 'espacio clásico de personal')}
    />
  )
}
