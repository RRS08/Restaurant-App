'use client'

// ----------------------------------------------------------------
// ScheduleHeader — top band of the staffing calendar card.
//
// Merges what used to be a page title + a toolbar + a day-pill row
// into a single header:
//   • date as the heading (21px, tight tracking); tap → month picker
//   • dirty chip ("Unsaved changes" / "Published") — cosmetic today,
//     will hook into a real staging flow later
//   • view segmented control (Day/Week), absolutely centred on the card
//   • stats line: "N on staff · Xh scheduled · Open 12p–5p"
//   • Copy last week + Publish buttons on the right
//   • swipe the band left / right to change weeks (no ‹ › cluster)
//   • day strip (Day view only), aligned to the grid's label gutter
//
// Local state: month-picker open/month, swipe origin/delta. Everything
// else is driven by props so the parent (staffing-calendar) stays the
// source of truth for weekStart / dayIndex / view.
// ----------------------------------------------------------------

import { useState } from 'react'
import type { Lang } from '@/lib/i18n'
import { makeT } from '@/lib/i18n'

// Palette — mirrors staffing-calendar so both files stay in sync.
const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const GHOST = '#C4C4C7'
const SURFACE = '#FAFAF9'
const BAND = '#F0EFEB'
const MONO = "'Geist Mono', ui-monospace, monospace"

const DAY_MS = 86_400_000
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS)
const mondayOf = (d: Date) => {
  const wd = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd)
}
const sameDayLocal = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

function fmtShortMin(m: number) {
  const h = Math.floor(m / 60) % 24
  const mm = m % 60
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`
}

// Per-day config the header needs to render the day strip + stats.
export interface DayConfig {
  /** [openMin, closeMin] in minutes from midnight, or null when closed */
  open: [number, number] | null
  /** how many shifts are scheduled that day — drives the strip badge */
  shifts: number
}

export interface ScheduleHeaderProps {
  lang: Lang
  view: 'day' | 'week'
  onViewChange: (v: 'day' | 'week') => void
  /** 0 = Mon … 6 = Sun */
  dayIndex: number
  onDayChange: (i: number) => void
  weekStart: Date
  onWeekStartChange: (d: Date) => void
  today: Date
  /** Mon..Sun config for the current week */
  days: DayConfig[]
  /** Cosmetic today — Publish button dims when false. */
  dirty: boolean
  onPublish: () => void
  onCopyLastWeek: () => void
  /** Preformatted totals for the stats line ("12h" / "164h"). */
  dayHours: string
  weekHours: string
  weekShifts: number
  /** Label-column width in the grid below — matches STAFF / DAY·HOURS. */
  gutter?: number
}

export default function ScheduleHeader({
  lang,
  view, onViewChange,
  dayIndex, onDayChange,
  weekStart, onWeekStartChange,
  today,
  days,
  dirty, onPublish, onCopyLastWeek,
  dayHours, weekHours, weekShifts,
  gutter = 170,
}: ScheduleHeaderProps) {
  const t = makeT(lang)
  const dateLocale = lang === 'es' ? 'es-ES' : 'en-US'

  const [calOpen, setCalOpen] = useState(false)
  const [calMonth, setCalMonth] = useState(() => new Date(weekStart.getFullYear(), weekStart.getMonth(), 1))
  const [swipeX, setSwipeX] = useState<number | null>(null)
  const [swipeDX, setSwipeDX] = useState(0)

  const isDay = view === 'day'
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const cfg = days[dayIndex] ?? { open: null, shifts: 0 }
  const dayDate = dates[dayIndex]
  const openDays = days.filter((d) => d.open).length

  const shiftWeek = (n: number) => {
    onWeekStartChange(addDays(weekStart, n * 7))
    setCalOpen(false)
  }

  const rangeText =
    `${dates[0].toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} – ` +
    `${dates[6].toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`

  const title = isDay
    ? dayDate.toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })
    : rangeText

  // Month grid — 6 rows of 7, Monday-first (matches Mon..Sun).
  const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1)
  const gridStart = mondayOf(first)
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(gridStart, i)
    return {
      d, i,
      inMonth: d.getMonth() === calMonth.getMonth(),
      inWeek: d >= weekStart && d < addDays(weekStart, 7),
      isToday: sameDayLocal(d, today),
    }
  })

  const monthLabel = calMonth.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' })
  const weekdayLetters = Array.from({ length: 7 }, (_, i) => {
    const sample = addDays(mondayOf(new Date()), i)
    return sample.toLocaleDateString(dateLocale, { weekday: 'narrow' })
  })

  const seg = (active: boolean): React.CSSProperties => ({
    border: 0, borderRadius: 8, height: 28, padding: '0 14px',
    font: 'inherit', fontSize: 12, cursor: 'pointer',
    background: active ? INK : 'transparent',
    color: active ? PAPER : MUTED,
    fontWeight: active ? 600 : 500,
  })

  return (
    <>
      {/* ---- Header band — pointer-swipe target ---- */}
      <div
        onPointerDown={(e) => {
          // Ignore swipes that start on interactive elements — otherwise
          // a slow click on the title button or a nav arrow would drag.
          const target = e.target as HTMLElement
          if (target.closest('button, input, select, textarea, [role="button"]')) return
          setSwipeX(e.clientX); setSwipeDX(0)
        }}
        onPointerMove={(e) => { if (swipeX !== null) setSwipeDX(e.clientX - swipeX) }}
        onPointerUp={() => {
          if (swipeX === null) return
          if (swipeDX <= -60) shiftWeek(1)
          else if (swipeDX >= 60) shiftWeek(-1)
          setSwipeX(null); setSwipeDX(0)
        }}
        onPointerLeave={() => { setSwipeX(null); setSwipeDX(0) }}
        style={{
          position: 'relative',
          padding: '16px 16px 14px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 24,
          flexWrap: 'wrap',
          touchAction: 'pan-y',
          cursor: swipeX === null ? 'default' : 'grabbing',
          transform: `translateX(${swipeDX / 6}px)`,
        }}
      >
        {/* View switch — absolutely centred, pinned to title's optical row */}
        <div style={{
          position: 'absolute', left: '50%', top: 18, transform: 'translateX(-50%)',
          zIndex: 2, display: 'flex', alignItems: 'center',
          background: '#F4F4F2', borderRadius: 10, padding: 3, gap: 2,
        }}>
          <button type="button" style={seg(isDay)} onClick={() => onViewChange('day')}>
            {t('Day', 'Día')}
          </button>
          <button type="button" style={seg(!isDay)} onClick={() => onViewChange('week')}>
            {t('Week', 'Semana')}
          </button>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => {
                setCalMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1))
                setCalOpen((v) => !v)
              }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                border: '1px solid transparent', background: 'transparent',
                borderRadius: 9, padding: '2px 8px', marginLeft: -8,
                font: 'inherit', color: INK, cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em', whiteSpace: 'nowrap' }}>
                {title}
              </span>
              <span style={{ fontSize: 10, color: FAINT }}>▾</span>
            </button>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
              padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
              background: dirty ? '#FFFBEB' : '#F4F4F2',
              color: dirty ? '#B45309' : MUTED,
            }}>
              {dirty ? t('Unsaved changes', 'Cambios sin publicar') : t('Published', 'Publicado')}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6, flexWrap: 'wrap' }}>
            <Stat
              value={isDay ? String(cfg.shifts) : String(weekShifts)}
              label={isDay ? t('on staff', 'en turno') : (weekShifts === 1 ? t('shift', 'turno') : t('shifts', 'turnos'))}
            />
            <Dot />
            <Stat value={isDay ? dayHours : weekHours} label={t('scheduled', 'programadas')} />
            <Dot />
            <span style={{ fontSize: 12, color: MUTED }}>
              {isDay
                ? cfg.open
                  ? `${t('Open', 'Abierto')} ${fmtShortMin(cfg.open[0])}–${fmtShortMin(cfg.open[1])}`
                  : t('Closed', 'Cerrado')
                : `${openDays} ${openDays === 1 ? t('open day', 'día abierto') : t('open days', 'días abiertos')}`}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onCopyLastWeek}
            style={{
              border: `1px solid ${LINE}`, background: '#fff', borderRadius: 10,
              height: 34, padding: '0 13px', font: 'inherit', fontSize: 13, fontWeight: 500,
              color: '#3F3F46', cursor: 'pointer',
            }}
          >
            {t('Copy last week', 'Copiar semana pasada')}
          </button>
          <button
            type="button"
            onClick={onPublish}
            style={{
              border: 0, background: INK, color: PAPER, borderRadius: 10, height: 34,
              padding: '0 16px', font: 'inherit', fontSize: 13, fontWeight: 600,
              opacity: dirty ? 1 : 0.45, cursor: dirty ? 'pointer' : 'default',
            }}
          >
            {dirty ? t('Publish changes', 'Publicar cambios') : t('Published', 'Publicado')}
          </button>
        </div>
      </div>

      {/* ---- Month picker — floating overlay ---- */}
      {calOpen && (
        <>
          <div onClick={() => setCalOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: 30 }} />
          <div style={{
            position: 'absolute', top: 62, left: 16, zIndex: 31, width: 300,
            border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
            boxShadow: '0 12px 32px rgba(24,24,27,0.14)', padding: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
              <MonthNav dir="‹" onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1))} />
              <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>
                {monthLabel}
              </span>
              <MonthNav dir="›" onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1))} />
            </div>

            {/* Weekday header — no horizontal gap so the week band
                below stays continuous. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 0, marginBottom: 6 }}>
              {weekdayLetters.map((l, i) => (
                <span key={i} style={{ textAlign: 'center', fontFamily: MONO, fontSize: 9, letterSpacing: '0.1em', color: FAINT }}>
                  {l}
                </span>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '3px 0' }}>
              {cells.map(({ d, i, inMonth, inWeek, isToday }) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    onWeekStartChange(mondayOf(d))
                    onDayChange((d.getDay() + 6) % 7)
                    setCalOpen(false)
                  }}
                  style={{
                    position: 'relative', border: 0, height: 30, font: 'inherit',
                    fontFamily: MONO, fontSize: 12, cursor: 'pointer',
                    ...(inWeek
                      ? {
                          background: BAND, color: INK, fontWeight: 600,
                          borderTopLeftRadius: i % 7 === 0 ? 8 : 0,
                          borderBottomLeftRadius: i % 7 === 0 ? 8 : 0,
                          borderTopRightRadius: i % 7 === 6 ? 8 : 0,
                          borderBottomRightRadius: i % 7 === 6 ? 8 : 0,
                        }
                      : { borderRadius: 8, background: 'transparent', color: inMonth ? '#3F3F46' : '#D6D5D1', fontWeight: 400 }),
                  }}
                >
                  {d.getDate()}
                  {isToday && (
                    <span style={{
                      position: 'absolute', left: '50%', bottom: 4, transform: 'translateX(-50%)',
                      width: 3, height: 3, borderRadius: '50%', background: inWeek ? INK : FAINT,
                    }} />
                  )}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
              <span style={{ fontSize: 11, color: FAINT }}>
                {t('Pick any date to jump to its week', 'Elige cualquier fecha para saltar a su semana')}
              </span>
              <button
                type="button"
                onClick={() => {
                  onWeekStartChange(mondayOf(today))
                  onDayChange((today.getDay() + 6) % 7)
                  setCalOpen(false)
                }}
                style={{
                  border: 0, background: 'transparent', padding: 0,
                  font: 'inherit', fontSize: 12, fontWeight: 500, color: '#2563EB', cursor: 'pointer',
                }}
              >
                {t('Today', 'Hoy')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ---- Day strip — Day view only, aligned to the grid gutter ---- */}
      {isDay && (
        <div style={{ display: 'flex', borderTop: `1px solid ${LINE}`, borderBottom: `1px solid ${LINE}` }}>
          <div style={{ width: gutter, flex: `0 0 ${gutter}px`, borderRight: `1px solid ${LINE}`, background: SURFACE }} />
          {days.map((d, i) => {
            const on = i === dayIndex
            const isClosed = !d.open
            const shortLabel = dates[i].toLocaleDateString(dateLocale, { weekday: 'short' })
            return (
              <button
                key={i}
                type="button"
                onClick={() => onDayChange(i)}
                style={{
                  flex: 1, minWidth: 0, border: 0, borderLeft: `1px solid ${LINE}`,
                  borderTop: `2px solid ${on ? INK : 'transparent'}`, marginTop: -1,
                  background: isClosed && !on ? '#FCFCFB' : '#fff',
                  padding: '8px 12px 9px', display: 'flex', flexDirection: 'column', gap: 2,
                  font: 'inherit', textAlign: 'left', cursor: 'pointer',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: on ? INK : isClosed ? GHOST : MUTED }}>
                    {shortLabel}
                  </span>
                  {d.shifts > 0 && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minWidth: 17, height: 17, borderRadius: 999, padding: '0 4px',
                      fontFamily: MONO, fontSize: 9, fontWeight: 600,
                      background: on ? INK : '#F4F4F2',
                      color: on ? PAPER : '#52525B',
                    }}>
                      {d.shifts}
                    </span>
                  )}
                </span>
                <span style={{
                  fontFamily: MONO, fontSize: 18, fontWeight: 600, letterSpacing: '-0.03em',
                  lineHeight: 1.05, color: on ? INK : isClosed ? GHOST : '#3F3F46',
                }}>
                  {dates[i].getDate()}
                </span>
                <span style={{
                  fontFamily: MONO, fontSize: 10,
                  color: isClosed ? '#D6D5D1' : on ? MUTED : FAINT,
                }}>
                  {isClosed ? t('Closed', 'Cerrado') : `${fmtShortMin(d.open![0])}–${fmtShortMin(d.open![1])}`}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em' }}>{value}</span>
      <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
    </span>
  )
}

function Dot() {
  return <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#D6D5D1' }} />
}

function MonthNav({ dir, onClick }: { dir: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 12, color: '#52525B', cursor: 'pointer',
      }}
    >
      {dir}
    </button>
  )
}
