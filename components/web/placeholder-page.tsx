// ----------------------------------------------------------------
// PlaceholderPage — calm, type-led "this sub-page exists but isn't
// built yet" surface. Reuses the same page rhythm as the rest of
// the /web shell (eyebrow + headline + framing copy + a quiet
// "in build" marker + optional classic-route fallback).
//
// Used by every sub-page that we've routed in but haven't filled
// with workflow yet. Each placeholder still pre-claims a real URL
// so links and bookmarks work today, and the IA reads as intended.
// ----------------------------------------------------------------

import Link from 'next/link'
import type { CSSProperties } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
const wrap = (extra: CSSProperties = {}): CSSProperties => ({
  maxWidth: 1160,
  margin: '0 auto',
  ...extra,
})

const eyebrow: CSSProperties = mono({
  fontSize: 11.5,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#6B6B70',
})

interface Props {
  eyebrowText: string
  title: string
  description: string
  /** Optional classic-route fallback. When present, a calm one-line
   *  link tells the owner where to do this job until the web-native
   *  workflow ships. */
  classicHref?: string
  classicCtaText?: string
  classicLinkLabel?: string
}

export function PlaceholderPage({
  eyebrowText,
  title,
  description,
  classicHref,
  classicCtaText,
  classicLinkLabel,
}: Props) {
  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>{eyebrowText}</div>
        <h1
          style={{
            fontSize: 'clamp(36px, 5.4vw, 56px)',
            lineHeight: 1.02,
            letterSpacing: '-1.6px',
            fontWeight: 700,
            margin: '14px 0 0',
            color: '#18181B',
          }}
        >
          {title}
        </h1>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.55,
            color: '#52525B',
            margin: '18px 0 0',
            maxWidth: 620,
          }}
        >
          {description}
        </p>
      </div>

      {/* In-build marker — calm, type-led, no card. Matches the
          home page's module preview "In build" tone exactly. */}
      <div
        style={{
          borderTop: '1px solid #E7E6E2',
          borderBottom: '1px solid #E7E6E2',
          padding: '36px 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: '#D4D7DD',
            display: 'inline-block',
          }}
        />
        <span style={{ ...eyebrow, color: '#9CA3AF' }}>In build</span>
      </div>

      {/* Classic fallback — only renders when a target exists. */}
      {classicHref && (
        <p style={{ fontSize: 14, color: '#9CA3AF', margin: '24px 0 0' }}>
          {classicCtaText ?? 'For now, this job lives in the'}{' '}
          <Link
            href={classicHref}
            style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}
          >
            {classicLinkLabel ?? 'classic workspace'}
          </Link>
          .
        </p>
      )}
    </div>
  )
}
