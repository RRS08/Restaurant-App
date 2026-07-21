'use client'

// ----------------------------------------------------------------
// TestimonialsCarousel — marketing testimonials strip.
//
// Replaces the CSS-only marquee that used to live inline in the
// marketing page. Reasons:
//   • The marquee cycled every 48s so it took forever to see the
//     real partner (Hatziri) come back around.
//   • No way to jump to a specific card — passive-only UX.
//   • Card heights weren't guaranteed uniform across variants.
//
// This carousel fixes all three:
//   • Auto-advance every 4s, hover pauses — one full cycle in
//     ~cards × 4s (currently 20s).
//   • Dots at the bottom mirror the card count; click to jump.
//     Active dot widens into a pill so the current position is
//     obvious at a glance.
//   • Every card locks to `height: 200 + boxSizing: border-box`
//     so partner and placeholder variants share the same vertical
//     footprint regardless of content.
//
// Scroll uses `scroll-snap-type: x mandatory` + `scrollIntoView`
// so keyboard/trackpad scrolling still feels native, and the auto
// advance's programmatic scrolls animate with the browser's own
// smooth-scroll (no rAF loop we own).
// ----------------------------------------------------------------

import { useState, useEffect, useRef, type CSSProperties } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })

// All cards lock to this exact footprint. Bumped from the old 188
// so the PartnerCard's logo + caption + padding have breathing
// room without pushing any single card taller than its neighbors.
const CARD_HEIGHT = 200
const CARD_WIDTH = 300
const CARD_GAP = 14
const AUTO_ADVANCE_MS = 4000

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
  const [activeIndex, setActiveIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  // Auto-advance. Hover pauses (setPaused via onMouseEnter/Leave
  // on the whole container). The timer effect depends on `paused`
  // so it tears down cleanly and restarts when the pointer leaves.
  useEffect(() => {
    if (paused) return
    const timer = window.setInterval(() => {
      setActiveIndex((i) => (i + 1) % items.length)
    }, AUTO_ADVANCE_MS)
    return () => window.clearInterval(timer)
  }, [paused, items.length])

  // Scroll the active card into the center of the track whenever
  // activeIndex changes — whether from the auto-advance timer, a
  // dot click, or a native swipe that landed on a new snap.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const card = track.children[activeIndex] as HTMLElement | undefined
    if (!card) return
    card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeIndex])

  const t = (en: string, es?: string) => (lang === 'es' && es ? es : en)

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* Track — horizontal scroller with snap points. The mask
          image is the same 5–95 % fade as the old marquee so
          cards near the edges of the viewport blend into the
          section bg instead of ending on a hard line. */}
      <div
        ref={trackRef}
        style={{
          display: 'flex',
          gap: CARD_GAP,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollSnapType: 'x mandatory',
          scrollBehavior: 'smooth',
          paddingBlock: 4,
          // Center the first/last card in the viewport so activeIndex
          // 0 and N-1 can actually land in the middle when scrolled to.
          paddingInline: 'max(24px, calc(50% - 150px))',
          WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)',
          maskImage: 'linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)',
          scrollbarWidth: 'none',
        }}
        // Hide native scrollbar in WebKit — the dot row IS the UI.
        className="mk-carousel-track"
      >
        {items.map((item, i) => (
          <div key={i} style={{ scrollSnapAlign: 'center', flex: `0 0 ${CARD_WIDTH}px` }}>
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

      {/* Dot navigation. Active dot widens into a pill so the
          current position is unmistakable. Buttons for real
          keyboard + screen-reader semantics; hover on any dot
          still pauses the timer (bubbles from the outer div). */}
      <div
        role="tablist"
        aria-label={t('Testimonial navigation', 'Navegación de testimonios')}
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          marginTop: 22,
        }}
      >
        {items.map((_, i) => {
          const active = i === activeIndex
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={t(`Go to testimonial ${i + 1} of ${items.length}`, `Ir al testimonio ${i + 1} de ${items.length}`)}
              onClick={() => setActiveIndex(i)}
              style={{
                width: active ? 24 : 8,
                height: 8,
                borderRadius: 4,
                background: active ? '#18181B' : '#D8D8D4',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                transition: 'width 220ms ease, background 220ms ease',
              }}
            />
          )
        })}
      </div>

      {/* Track-scrollbar hider — CSS-only, colocated via a <style>
          tag so this component stays self-contained. */}
      <style>{`
        .mk-carousel-track::-webkit-scrollbar{display:none}
      `}</style>
    </div>
  )
}

// ----------------------------------------------------------------
// TestimonialCard — placeholder-shape card. Same visual as before.
// Height is now hard-locked so it matches PartnerCard exactly.
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
// PartnerCard — real pilot partner. Same flip behavior as before.
// Height hard-locked to match TestimonialCard.
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
