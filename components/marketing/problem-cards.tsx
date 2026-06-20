'use client'

// ProblemCards — five disconnected tools; a single black fill travels
// card → card at a reading cadence. Starts only when scrolled into view.

import { useEffect, useRef, useState } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'

const PROBLEMS = [
  { n: '01', t: 'A POS', d: 'Takes the money. Knows nothing about stock.' },
  { n: '02', t: 'A spreadsheet', d: 'For stock. Last updated… you’re not sure.' },
  { n: '03', t: 'A notebook', d: 'The schedule, in your handwriting.' },
  { n: '04', t: 'The bank app', d: 'For money. Two days behind reality.' },
  { n: '05', t: 'Your head', d: 'Everything else. Until 11pm.' },
]

// dwell per card (ms) — mimics reading them aloud; longest on "Your head".
// First dwell is shorter so the spotlight starts traveling soon after
// the cards scroll into view (the static state shouldn't sit there
// pretending nothing's about to happen).
const DWELL = [800, 1700, 1600, 1750, 2600]
// Phone uses a single-card crossfade slideshow (see CSS below), so each
// dwell is the only time the reader gets with that card — at desktop
// speeds it looked like flashcards. These are calibrated to feel like
// "one beat of reading aloud" per card on a phone-held cadence.
const DWELL_PHONE = [2200, 2700, 2600, 2800, 3500]

export default function ProblemCards() {
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const idx = useRef(0)
  const started = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Same start condition as FloorSim: fire once the element is
    // at least 30% in view. Keeps both simulations in sync — they
    // begin at the same scroll position so the page reads as one
    // coordinated reveal, not two separate effects.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.3 && !started.current) {
            started.current = true
            const dwells = typeof window !== 'undefined' && window.innerWidth <= 640
              ? DWELL_PHONE
              : DWELL
            const step = () => {
              timer.current = setTimeout(() => {
                idx.current = (idx.current + 1) % PROBLEMS.length
                setActive(idx.current)
                step()
              }, dwells[idx.current])
            }
            step()
            break
          }
        }
      },
      { threshold: [0.3] },
    )
    io.observe(el)
    return () => { io.disconnect(); clearTimeout(timer.current) }
  }, [])

  return (
    <div ref={ref} className="mk-problem-cards" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {/* Phone-only override: stop the five-card grid (which on a
          narrow viewport stacks into five stacked rows with the
          black spotlight visibly cycling through them — busy, and
          the user can't read all five at a glance anyway). On phone
          the grid collapses into a single absolute-stacked deck of
          cards, only the active one visible, crossfading on dwell.
          Same dwelling logic upstairs; the visual presentation
          becomes a single-card slideshow with a row of position
          dots underneath so the "this is a series of five" intent
          stays obvious. */}
      <style>{`
        @media (max-width: 640px) {
          .mk-problem-cards {
            position: relative;
            min-height: 160px;
            display: block !important;
          }
          .mk-problem-card {
            position: absolute !important;
            top: 0; left: 0; right: 0;
            opacity: 0;
            pointer-events: none;
            transition: opacity .45s ease;
            flex: none !important;
          }
          .mk-problem-card.is-active {
            opacity: 1;
            pointer-events: auto;
          }
          .mk-problem-dots {
            display: flex !important;
            gap: 8px;
            justify-content: center;
            position: absolute;
            left: 0; right: 0;
            bottom: -22px;
          }
          .mk-problem-dots > span {
            width: 6px; height: 6px; border-radius: 50%;
            background: rgba(24,24,27,0.18);
            transition: background .35s ease, transform .35s ease;
          }
          .mk-problem-dots > span.is-active {
            background: #18181B;
            transform: scale(1.35);
          }
        }
        .mk-problem-dots { display: none; }
        @media (prefers-reduced-motion: reduce) {
          .mk-problem-card { transition: none !important; }
        }
      `}</style>
      {PROBLEMS.map((p, i) => {
        const on = i === active
        return (
          <div
            key={p.n}
            className={`mk-problem-card${on ? ' is-active' : ''}`}
            style={{
              flex: '1 1 160px',
              background: on ? '#18181B' : '#FFFFFF',
              border: `1px solid ${on ? '#18181B' : '#E7E6E2'}`,
              borderRadius: 13, padding: 18,
              transition: 'background .85s ease, border-color .85s ease',
            }}
          >
            <div style={{ fontFamily: MONO, fontSize: 11, color: on ? '#6B6B70' : '#A1A1A6', transition: 'color .85s ease' }}>{p.n}</div>
            <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 8, color: on ? '#FAF9F6' : '#18181B', transition: 'color .85s ease' }}>{p.t}</div>
            <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45, color: on ? '#C9C9CE' : '#6B6B70', transition: 'color .85s ease' }}>{p.d}</div>
          </div>
        )
      })}
      {/* Phone-only position dots. Hidden on tablet+ via the CSS
          above; the desktop layout already shows all five cards
          so an index indicator would be noise. */}
      <div className="mk-problem-dots" aria-hidden="true">
        {PROBLEMS.map((p, i) => (
          <span key={p.n} className={i === active ? 'is-active' : undefined} />
        ))}
      </div>
    </div>
  )
}
