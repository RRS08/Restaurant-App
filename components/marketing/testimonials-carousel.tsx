'use client'

// ----------------------------------------------------------------
// TestimonialsCarousel — marketing testimonials strip.
//
// Marquee-style continuous scroll (RAF-driven translation) with
// dot navigation, hover-pause, and reduced-motion honor.
//
// Why RAF and not a CSS animation:
//   • Clicking a dot needs to jump the track to a specific
//     position AND have the auto-scroll resume from there. A CSS
//     @keyframes animation has no idea about that runtime state,
//     so mid-animation jumps snap back or double-up.
//   • With RAF we own the offset; hover pauses it, clicks reseat
//     it, resume continues from wherever it is — coherent state.
//
// Items are rendered twice ([...items, ...items]) so the wrap
// at one-set-length is visually invisible: the card at that
// physical index sits at the exact same on-screen x as the card
// at index 0, making the reset seamless.
//
// All cards lock to height=200 + boxSizing:border-box so the
// PartnerCard variant and placeholder cards share the exact same
// vertical footprint regardless of content.
// ----------------------------------------------------------------

import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })

const CARD_HEIGHT = 200
const CARD_WIDTH = 300
const CARD_GAP = 14
const SCROLL_SPEED_PX_PER_SEC = 30 // Continuous marquee speed.

export interface Testimonial {
  q: string
  who: string
  city: string
  logo?: string
  href?: string
  businessName?: string
}

export default function TestimonialsCarousel({
  items,
  lang,
}: {
  items: Testimonial[]
  lang: 'en' | 'es'
}) {
  const cardStep = CARD_WIDTH + CARD_GAP
  const setLen = items.length * cardStep // width of one unique set

  const [activeIdx, setActiveIdx] = useState(0)
  const [paused, setPaused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  const trackRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef(0)

  // Respect prefers-reduced-motion — the RAF loop is JS, not CSS,
  // so it won't get killed by the global reduce-motion rule. Query
  // once on mount and keep the marquee static for those users; the
  // dots still work for manual navigation.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Applies the current offset to the track transform and derives
  // the closest-card index for the dot indicator. Refs (not state)
  // for offset so we can mutate 60× per second without re-renders.
  const applyOffset = useCallback((off: number) => {
    if (trackRef.current) {
      trackRef.current.style.transform = `translate3d(${-off}px, 0, 0)`
    }
    const nearIdx = ((Math.round(off / cardStep) % items.length) + items.length) % items.length
    setActiveIdx((prev) => (prev === nearIdx ? prev : nearIdx))
  }, [cardStep, items.length])

  // RAF continuous-scroll loop. Torn down on pause/reduced-motion
  // and cleanly restarted from wherever offsetRef sits — no jumps
  // when the pointer enters/leaves the section.
  useEffect(() => {
    if (paused || reducedMotion) return
    lastTsRef.current = 0
    const tick = (ts: number) => {
      if (lastTsRef.current === 0) lastTsRef.current = ts
      const dt = ts - lastTsRef.current
      lastTsRef.current = ts
      offsetRef.current += (SCROLL_SPEED_PX_PER_SEC * dt) / 1000
      // Wrap once we've scrolled a full set. Because items are
      // rendered twice, the on-screen visual at wrap == the visual
      // at offset 0, so the reset is invisible.
      if (offsetRef.current >= setLen) offsetRef.current -= setLen
      applyOffset(offsetRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTsRef.current = 0
    }
  }, [paused, reducedMotion, setLen, applyOffset])

  // Dot click — snap the marquee so the picked card sits at the
  // left edge of the viewport. The RAF loop (if running) picks up
  // from that new offset on the next frame.
  const goTo = (idx: number) => {
    offsetRef.current = idx * cardStep
    applyOffset(offsetRef.current)
  }

  const t = (en: string, es?: string) => (lang === 'es' && es ? es : en)
  const doubledItems = [...items, ...items]

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* Viewport — clips the wide track and fades the edges so
          partially-visible cards blend into the section bg. */}
      <div
        style={{
          overflow: 'hidden',
          WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)',
          maskImage: 'linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)',
        }}
      >
        <div
          ref={trackRef}
          style={{
            display: 'flex',
            gap: CARD_GAP,
            width: 'max-content',
            willChange: 'transform',
          }}
        >
          {doubledItems.map((item, i) => (
            <div key={i} style={{ flex: `0 0 ${CARD_WIDTH}px` }}>
              {item.logo && item.href && item.businessName ? (
                <PartnerCard
                  q={item.q} who={item.who} city={item.city}
                  logo={item.logo} href={item.href} businessName={item.businessName}
                />
              ) : (
                <TestimonialCard q={item.q} who={item.who} city={item.city} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Dot navigation. Same-size circles, active dot just gets
          darker — no shape shift. Full ARIA tablist semantics. */}
      <div
        role="tablist"
        aria-label={t('Testimonial navigation', 'Navegación de testimonios')}
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 10,
          marginTop: 22,
        }}
      >
        {items.map((_, i) => {
          const active = i === activeIdx
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={t(`Go to testimonial ${i + 1} of ${items.length}`, `Ir al testimonio ${i + 1} de ${items.length}`)}
              onClick={() => goTo(i)}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: active ? '#18181B' : '#D8D8D4',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                transition: 'background 200ms ease',
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// TestimonialCard — placeholder-shape card. Height hard-locked to
// match PartnerCard exactly.
// ----------------------------------------------------------------
function TestimonialCard({ q, who, city }: { q: string; who: string; city: string }) {
  return (
    <div style={{
      width: CARD_WIDTH, height: CARD_HEIGHT, boxSizing: 'border-box',
      background: '#FFFFFF', border: '1px dashed #D8D8D4', borderRadius: 16, padding: 24,
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    }}>
      <div>
        <div style={mono({ fontSize: 34, lineHeight: 0.7, color: '#DCDAD4' })}>&ldquo;</div>
        <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#A1A1A6', margin: '10px 0 0' }}>{q}</p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 18 }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'repeating-linear-gradient(135deg,#EFEFEC 0 6px,#E7E6E2 6px 12px)' }} />
        <div style={mono({ fontSize: 11, lineHeight: 1.4, color: '#A1A1A6' })}>{who}<br />{city}</div>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// PartnerCard — real pilot partner. Flip on hover, whole card is
// an anchor to the partner's site. Height hard-locked.
// ----------------------------------------------------------------
function PartnerCard({
  q, who, city, logo, href, businessName,
}: {
  q: string; who: string; city: string
  logo: string; href: string; businessName: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${businessName} — ${who}, ${city}`}
      className="mk-partner-card"
      style={{
        width: CARD_WIDTH, height: CARD_HEIGHT, boxSizing: 'border-box',
        perspective: '1000px', textDecoration: 'none', color: 'inherit', display: 'block',
      }}
    >
      <div
        className="mk-partner-inner"
        style={{
          position: 'relative', width: '100%', height: '100%',
          transformStyle: 'preserve-3d',
          transition: 'transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div style={{
          position: 'absolute', inset: 0, background: '#FFFFFF',
          border: '1px solid #E7E6E2', borderRadius: 16, padding: 18,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
          backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} alt={businessName} style={{ maxWidth: '100%', maxHeight: 128, objectFit: 'contain', display: 'block' }} />
          <div style={mono({ fontSize: 10, color: '#A1A1A6', letterSpacing: '0.08em', textAlign: 'center' })}>{businessName}</div>
        </div>
        <div style={{
          position: 'absolute', inset: 0, background: '#FFFFFF',
          border: '1px solid #18181B', borderRadius: 16, padding: 24,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
          transform: 'rotateY(180deg)',
        }}>
          <div>
            <div style={mono({ fontSize: 34, lineHeight: 0.7, color: '#DCDAD4' })}>&ldquo;</div>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: '#18181B', margin: '10px 0 0', fontWeight: 500 }}>{q}</p>
          </div>
          <div style={mono({ fontSize: 11, lineHeight: 1.4, color: '#52525B' })}>{who}<br />{city}</div>
        </div>
      </div>
    </a>
  )
}
