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
            const step = () => {
              timer.current = setTimeout(() => {
                idx.current = (idx.current + 1) % PROBLEMS.length
                setActive(idx.current)
                step()
              }, DWELL[idx.current])
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
    <div ref={ref} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {PROBLEMS.map((p, i) => {
        const on = i === active
        return (
          <div key={p.n} style={{
            flex: '1 1 160px',
            background: on ? '#18181B' : '#FFFFFF',
            border: `1px solid ${on ? '#18181B' : '#E7E6E2'}`,
            borderRadius: 13, padding: 18,
            transition: 'background .85s ease, border-color .85s ease',
          }}>
            <div style={{ fontFamily: MONO, fontSize: 11, color: on ? '#6B6B70' : '#A1A1A6', transition: 'color .85s ease' }}>{p.n}</div>
            <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 8, color: on ? '#FAF9F6' : '#18181B', transition: 'color .85s ease' }}>{p.t}</div>
            <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45, color: on ? '#C9C9CE' : '#6B6B70', transition: 'color .85s ease' }}>{p.d}</div>
          </div>
        )
      })}
    </div>
  )
}
