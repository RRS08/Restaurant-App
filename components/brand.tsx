// ----------------------------------------------------------------
// Checked — brand components
//
// One source of truth for the product mark + wordmark. Three exports:
//
//   <BrandMark />     just the clipboard-with-checkmark glyph
//   <BrandWordmark /> just the "checked" type
//   <BrandLockup />   mark + wordmark side-by-side
//
// Every export defaults to the dark "ink" palette (#18181B) on a
// light surface. Pass `tone="onDark"` to flip into the reversed
// treatment used in dark areas (e.g. a navy banner or the sidebar's
// dark-mode variant). Sizing is via the `size` prop on the mark and
// the wordmark so callers can scale without overriding CSS.
//
// IMPORTANT — keep these SVGs aligned with the published brand
// assets in `/brand/` (checked-app-icon.svg, checked-icon-mark.svg,
// checked-horizontal.svg). The geometry below is copied from those
// files verbatim so the in-app render is bit-for-bit identical to
// the marketing site / print collateral.
// ----------------------------------------------------------------

import { cn } from '@/lib/utils'

export const BRAND_INK = '#18181B'
export const BRAND_PAPER = '#FAF9F6'
export const BRAND_SLATE = '#6B6B70'

type Tone = 'onLight' | 'onDark'

// ----------------------------------------------------------------
// BrandMark — clipboard with three rules + a check mark.
//
// `variant`:
//   - "solid"   filled dark tile with white knockout glyph
//               (the app-icon treatment — looks like a real icon).
//   - "flat"    one-color glyph only, no tile. For dense headers
//               (sidebar, login form) where a solid tile would
//               compete with the surrounding white card.
// ----------------------------------------------------------------
export function BrandMark({
  size = 32,
  variant = 'solid',
  tone = 'onLight',
  className,
}: {
  size?: number
  variant?: 'solid' | 'flat'
  tone?: Tone
  className?: string
}) {
  // Color resolution:
  //   solid: tile = ink, glyph = paper. Reversed → tile=paper, glyph=ink.
  //   flat:  glyph follows tone. onLight → ink. onDark → paper.
  const ink = tone === 'onDark' ? BRAND_PAPER : BRAND_INK
  const paper = tone === 'onDark' ? BRAND_INK : BRAND_PAPER

  if (variant === 'solid') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 120 120"
        role="img"
        aria-label="Checked"
        className={className}
      >
        <rect width="120" height="120" rx="28" fill={ink} />
        <g transform="translate(8.8,8.8) scale(1.6)">
          <path
            d="M24 10h16a4 4 0 0 1 4 4v36a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z"
            fill={paper}
          />
          <rect x="26" y="16" width="14" height="3" rx="1.5" fill={ink} />
          <rect x="26" y="23" width="11" height="3" rx="1.5" fill={ink} />
          <rect x="26" y="30" width="8" height="3" rx="1.5" fill={ink} />
          <path
            d="M27 41l4 4 8-9"
            fill="none"
            stroke={ink}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    )
  }

  // flat — single-tone glyph, no tile background.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Checked"
      className={className}
    >
      <path
        d="M24 10h16a4 4 0 0 1 4 4v36a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z"
        fill={ink}
      />
      <rect x="26" y="16" width="14" height="3" rx="1.5" fill={paper} />
      <rect x="26" y="23" width="11" height="3" rx="1.5" fill={paper} />
      <rect x="26" y="30" width="8" height="3" rx="1.5" fill={paper} />
      <path
        d="M27 41l4 4 8-9"
        fill="none"
        stroke={paper}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ----------------------------------------------------------------
// BrandWordmark — "checked" set in the system bold sans, letter-
// spaced -0.04em to match the asset typography (Helvetica Neue
// Bold @ -1.5 tracking at 40px).
// ----------------------------------------------------------------
export function BrandWordmark({
  size = 'md',
  tone = 'onLight',
  className,
}: {
  /** sm = 14px · md = 20px · lg = 28px · xl = 40px */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  tone?: Tone
  className?: string
}) {
  const sizeClass =
    size === 'sm' ? 'text-sm'
      : size === 'md' ? 'text-xl'
        : size === 'lg' ? 'text-3xl'
          : 'text-4xl'
  return (
    <span
      className={cn(
        'font-bold tracking-[-0.04em] leading-none',
        tone === 'onDark' ? 'text-[#FAF9F6]' : 'text-[#18181B]',
        sizeClass,
        className,
      )}
    >
      checked
    </span>
  )
}

// ----------------------------------------------------------------
// BrandLockup — horizontal mark + wordmark, the primary product
// signature. Used in the landing-page nav, auth pages, and other
// "this is the product" surfaces.
// ----------------------------------------------------------------
export function BrandLockup({
  size = 'md',
  variant = 'flat',
  tone = 'onLight',
  className,
}: {
  size?: 'sm' | 'md' | 'lg'
  variant?: 'solid' | 'flat'
  tone?: Tone
  className?: string
}) {
  // Mark + wordmark sized in lockstep so the optical balance from
  // the brand sheet is preserved across the three lockup sizes.
  const markPx = size === 'sm' ? 20 : size === 'md' ? 28 : 40
  const wordSize: 'sm' | 'md' | 'lg' | 'xl' =
    size === 'sm' ? 'sm' : size === 'md' ? 'md' : 'lg'
  const gap = size === 'sm' ? 'gap-1.5' : 'gap-2'
  return (
    <span className={cn('inline-flex items-center', gap, className)}>
      <BrandMark size={markPx} variant={variant} tone={tone} />
      <BrandWordmark size={wordSize} tone={tone} />
    </span>
  )
}
