'use client'

// ----------------------------------------------------------------
// WebStaffingClient — web-native staffing display.
//
//   eyebrow + headline + summary
//   today snapshot (on-shift · scheduled hours · team size)
//   today's shifts list
//   team roster
//   focused card on shift click → role · section · time · notes
// ----------------------------------------------------------------

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { makeT, type Lang } from '@/lib/i18n'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
const wrap = (extra: CSSProperties = {}): CSSProperties => ({ maxWidth: 1160, margin: '0 auto', ...extra })
const eyebrow: CSSProperties = mono({
  fontSize: 11.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6B6B70',
})

interface Employee { id: string; name: string; role: string | null; primaryLocationId: string | null }
interface Shift {
  id: string; employeeName: string | null; role: string | null
  sectionName: string | null; sectionArea: string | null
  startTime: string; endTime: string; notes: string | null
}
interface Props { lang: Lang; employees: Employee[]; shifts: Shift[] }

export default function WebStaffingClient({ lang, employees, shifts }: Props) {
  const t = makeT(lang)
  const [focused, setFocused] = useState<Shift | null>(null)

  useEffect(() => {
    if (!focused) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocused(null) }
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
  }, [focused])

  const { todays, scheduledHours, onShiftNow } = useMemo(() => {
    const now = new Date()
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1)
    const ts = todayStart.getTime(); const te = todayEnd.getTime()
    const ns = now.getTime()
    const todays = shifts.filter((s) => {
      const start = new Date(s.startTime).getTime()
      return start >= ts && start < te
    })
    let hours = 0; let onShift = 0
    for (const s of todays) {
      const start = new Date(s.startTime).getTime()
      const end = new Date(s.endTime).getTime()
      hours += Math.max(0, (end - start) / (1000 * 60 * 60))
      if (start <= ns && ns <= end) onShift += 1
    }
    return { todays: todays.sort((a, b) => a.startTime.localeCompare(b.startTime)), scheduledHours: hours, onShiftNow: onShift }
  }, [shifts])

  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>
          {t('Staffing', 'Personal')} · {t(`${employees.length} on the team`, `${employees.length} en el equipo`)}
        </div>
        <h1 style={{
          fontSize: 'clamp(36px, 5.4vw, 56px)', lineHeight: 1.02,
          letterSpacing: '-1.6px', fontWeight: 700, margin: '14px 0 0', color: '#18181B',
        }}>
          {t('Today’s lineup.', 'Equipo de hoy.')}
        </h1>
        <p style={{
          fontSize: 17, lineHeight: 1.55, color: '#52525B',
          margin: '18px 0 0', maxWidth: 620,
        }}>
          {t(
            'Who’s on, when they’re on, and what they’re running.',
            'Quién está en turno, cuándo y qué están cubriendo.'
          )}
        </p>
      </div>

      <section style={{
        marginBottom: 36,
        borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
        display: 'flex',
      }}>
        <SnapshotCell label={t('On shift now', 'En turno ahora')} value={`${onShiftNow}`} isFirst />
        <SnapshotCell label={t('Scheduled today', 'Programado hoy')} value={`${todays.length}`} />
        <SnapshotCell label={t('Scheduled hours', 'Horas programadas')} value={`${scheduledHours.toFixed(1)}`} />
      </section>

      {/* TODAY'S SHIFTS */}
      <section style={{ marginBottom: 56 }}>
        <h2 style={{
          fontSize: 'clamp(22px, 2.4vw, 28px)', lineHeight: 1.1,
          letterSpacing: '-0.6px', fontWeight: 700, margin: '0 0 16px', color: '#18181B',
        }}>
          {t('Today’s shifts', 'Turnos de hoy')}
        </h2>
        {todays.length === 0 ? (
          <div style={{
            borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
            padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14,
          }}>
            {t('No shifts scheduled today.', 'Sin turnos programados hoy.')}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {todays.map((s, idx) => (
              <li key={s.id} style={{
                borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                borderBottom: '1px solid #E7E6E2',
              }}>
                <button
                  type="button" onClick={() => setFocused(s)}
                  className="web-shift-row"
                  style={{
                    display: 'grid', width: '100%',
                    gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(80px, auto)',
                    gap: 18, alignItems: 'center', padding: '14px 0',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontFamily: 'inherit', color: 'inherit', textAlign: 'left',
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#18181B' }}>
                    {s.employeeName ?? t('Unassigned', 'Sin asignar')}
                  </div>
                  <div style={mono({ fontSize: 12, color: '#52525B' })}>
                    {s.role ?? '—'}
                  </div>
                  <div style={mono({ fontSize: 12, color: '#52525B' })}>
                    {s.sectionName ?? '—'}
                  </div>
                  <div style={mono({ fontSize: 13, color: '#18181B', textAlign: 'right' })}>
                    {formatTime(s.startTime)}–{formatTime(s.endTime)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* TEAM ROSTER */}
      <section>
        <h2 style={{
          fontSize: 'clamp(22px, 2.4vw, 28px)', lineHeight: 1.1,
          letterSpacing: '-0.6px', fontWeight: 700, margin: '0 0 16px', color: '#18181B',
        }}>
          {t('Team', 'Equipo')}{' '}
          <span style={mono({ fontSize: 16, fontWeight: 500, color: '#9CA3AF' })}>
            {employees.length}
          </span>
        </h2>
        {employees.length === 0 ? (
          <div style={{
            borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
            padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14,
          }}>
            {t('No employees yet.', 'Aún sin empleados.')}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {employees.map((e, idx) => (
              <li key={e.id} style={{
                borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                borderBottom: '1px solid #E7E6E2',
                padding: '14px 0',
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, auto)',
                gap: 18, alignItems: 'center',
              }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: '#18181B' }}>{e.name}</span>
                <span style={mono({ fontSize: 12, color: '#52525B' })}>{e.role ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <FooterLink t={t} />

      {focused && (
        <FocusedShiftCard shift={focused} onClose={() => setFocused(null)} t={t} />
      )}

      <style>{`
        .web-shift-row:hover { background: rgba(24,24,27,0.025); }
        @keyframes webModalBackdropIn { from{opacity:0} to{opacity:1} }
        @keyframes webModalCardIn { from{opacity:0;transform:translateY(8px) scale(.985)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>
  )
}

function SnapshotCell({ label, value, isFirst }: { label: string; value: string; isFirst?: boolean }) {
  return (
    <div style={{
      flex: 1, padding: '18px 20px',
      borderLeft: isFirst ? 'none' : '1px solid #E7E6E2',
    }}>
      <div style={eyebrow}>{label}</div>
      <div style={mono({ fontSize: 26, fontWeight: 600, lineHeight: 1, color: '#18181B', marginTop: 10 })}>
        {value}
      </div>
    </div>
  )
}

function FocusedShiftCard({ shift, onClose, t }: {
  shift: Shift; onClose: () => void; t: (en: string, es?: string) => string
}) {
  return (
    <div
      className="web-modal-backdrop" role="dialog" aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(24,24,27,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, backdropFilter: 'saturate(1.1) blur(2px)',
        animation: 'webModalBackdropIn 180ms ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto',
          background: '#FAF9F6', border: '1px solid #E0DED7',
          borderRadius: 16, boxShadow: '0 24px 60px -20px rgba(24,24,27,0.32)',
          animation: 'webModalCardIn 240ms cubic-bezier(0.22, 0.7, 0.2, 1)',
        }}
      >
        <div style={{
          position: 'sticky', top: 0, background: '#FAF9F6',
          padding: '24px 28px 20px', borderBottom: '1px solid #E7E6E2',
          display: 'flex', justifyContent: 'space-between', gap: 18,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrow}>{t('Shift', 'Turno')}</div>
            <h2 style={{
              fontSize: 'clamp(24px, 3vw, 30px)', lineHeight: 1.1,
              letterSpacing: '-0.8px', fontWeight: 700, margin: '6px 0 0', color: '#18181B',
            }}>
              {shift.employeeName ?? t('Unassigned', 'Sin asignar')}
            </h2>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {shift.role && (
                <span style={mono({
                  fontSize: 10.5, letterSpacing: '0.06em', padding: '4px 9px',
                  borderRadius: 6, background: '#F1F0EC', color: '#6B6B70',
                  textTransform: 'uppercase', fontWeight: 500,
                })}>{shift.role}</span>
              )}
              {shift.sectionArea && (
                <span style={mono({
                  fontSize: 10.5, letterSpacing: '0.06em', padding: '4px 9px',
                  borderRadius: 6, background: '#F1F0EC', color: '#6B6B70',
                  textTransform: 'uppercase', fontWeight: 500,
                })}>{shift.sectionArea}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label={t('Close', 'Cerrar')} style={closeBtn}>×</button>
        </div>

        <div style={{ padding: '24px 28px 28px' }}>
          <div style={{
            display: 'flex', alignItems: 'stretch',
            borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
          }}>
            <Cell label={t('Start', 'Inicio')} value={formatTime(shift.startTime)} isFirst />
            <Cell label={t('End', 'Fin')} value={formatTime(shift.endTime)} />
            <Cell label={t('Section', 'Sección')} value={shift.sectionName ?? '—'} />
          </div>

          {shift.notes && (
            <section style={{ marginTop: 32 }}>
              <div style={eyebrow}>{t('Notes', 'Notas')}</div>
              <p style={{ fontSize: 14, color: '#52525B', lineHeight: 1.55, margin: '12px 0 0' }}>
                {shift.notes}
              </p>
            </section>
          )}

          <p style={{ fontSize: 13, color: '#9CA3AF', margin: '28px 0 0' }}>
            {t('Edit this shift or build the schedule in the', 'Edita el turno o construye el horario en el')}{' '}
            <Link href="/staffing" style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
              {t('classic staffing workspace', 'espacio clásico de personal')}
            </Link>.
          </p>
        </div>
      </div>
    </div>
  )
}

const closeBtn: CSSProperties = {
  flex: '0 0 auto', width: 36, height: 36, borderRadius: 8,
  border: '1px solid #E7E6E2', background: 'transparent', color: '#6B6B70',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 18, lineHeight: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}

function Cell({ label, value, isFirst }: { label: string; value: string; isFirst?: boolean }) {
  return (
    <div style={{
      flex: 1, padding: '18px 20px',
      borderLeft: isFirst ? 'none' : '1px solid #E7E6E2',
    }}>
      <div style={eyebrow}>{label}</div>
      <div style={mono({ fontSize: 22, fontWeight: 600, lineHeight: 1, color: '#18181B', marginTop: 10 })}>
        {value}
      </div>
    </div>
  )
}

function FooterLink({ t }: { t: (en: string, es?: string) => string }) {
  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid #E7E6E2' }}>
      <p style={{ fontSize: 14, color: '#9CA3AF', margin: 0 }}>
        {t('Need to build a schedule, add an employee, or set sections?', '¿Necesitas armar un horario, agregar a alguien o configurar secciones?')}{' '}
        <Link href="/staffing" style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
          {t('Open the classic staffing workspace', 'Abre el espacio clásico de personal')}
        </Link>.
      </p>
    </div>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
