'use client'

// ----------------------------------------------------------------
// DemoForm — "Book a demo" capture for the marketing CTA.
//
// Submits through the submitDemoLead server action which lands the
// payload in `demo_leads` (RLS-locked, dev-readable via /dev-tools).
// Three filters before a lead persists as accepted:
//
//   1. Honeypot — the hidden `website` input below. Real users never
//      fill it; bots that auto-populate every form field will, and
//      the server logs a `rejected=true, rejection_reason='honeypot'`
//      row + returns a fake-success so the bot can't tell.
//
//   2. IP rate limit — 5 submissions per IP per hour, enforced on
//      the server.
//
//   3. Cloudflare Turnstile — only enforced when the env var is set
//      (no client-side render unless `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
//      is configured). Until then, honeypot + rate limit carry the load.
// ----------------------------------------------------------------

import { useActionState, useState } from 'react'
import type { CSSProperties } from 'react'
import { submitDemoLead } from '@/app/actions/demo-leads'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'

// Concept options span both sides of the business — food service
// concepts first, then retail concepts. Order matters: it hints
// what we're best known for while making clear retail is welcome.
const CONCEPTS_EN = [
  'Taqueria / tacos', 'Mariscos', 'Panadería / bakery', 'BBQ',
  'Breakfast / cafe', 'Burgers',
  'Boutique / apparel', 'Convenience / c-store', 'Gift / specialty',
  'Beauty / cosmetics', 'Other retail',
  'Other',
]
const CONCEPTS_ES = [
  'Taquería / tacos', 'Mariscos', 'Panadería', 'BBQ',
  'Desayunos / café', 'Hamburguesas',
  'Boutique / ropa', 'Tienda de conveniencia', 'Regalos / especialidad',
  'Belleza / cosméticos', 'Otro retail',
  'Otro',
]

interface Props {
  lang?: 'en' | 'es'
}

export default function DemoForm({ lang = 'en' }: Props) {
  const t = (en: string, es?: string): string => (lang === 'es' && es ? es : en)
  const CONCEPTS = lang === 'es' ? CONCEPTS_ES : CONCEPTS_EN
  const [state, action, pending] = useActionState(submitDemoLead, null)
  const [concept, setConcept] = useState(CONCEPTS[0])

  const label: CSSProperties = {
    fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6B70',
  }
  const field: CSSProperties = {
    width: '100%', marginTop: 8, background: '#18181B', color: '#FAF9F6', fontSize: 15,
    fontFamily: 'inherit', padding: '13px 14px', borderRadius: 10, outline: 'none',
  }

  if (state?.ok) {
    return (
      <div className="mk-demo-form" style={{ flex: '1 1 360px', background: '#232327', border: '1px solid #34343A', borderRadius: 18, padding: 26 }}>
        <div style={{ textAlign: 'center', padding: '24px 8px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: '50%', background: '#FAF9F6', color: '#18181B', fontSize: 24 }}>✓</div>
          <div style={{ fontSize: 21, fontWeight: 700, marginTop: 18 }}>{t('You’re on the list.', 'Ya quedaste en la lista.')}</div>
          <p style={{ fontSize: 15, color: '#C9C9CE', margin: '10px 0 0', lineHeight: 1.5 }}>{t(
            'I’ll reach out within a day to set up your demo. Talk soon. — Renato Ruiz Sandoval',
            'Te contacto en menos de un día para agendar tu demo. Hablamos pronto. — Renato Ruiz Sandoval'
          )}</p>
        </div>
      </div>
    )
  }

  return (
    <form action={action} className="mk-demo-form" style={{ flex: '1 1 360px', background: '#232327', border: '1px solid #34343A', borderRadius: 18, padding: 26 }}>
      <label style={label} htmlFor="demo_email">{t('Your email', 'Tu correo')}</label>
      <input
        id="demo_email"
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder={t('you@yourrestaurant.com', 'tu@turestaurante.com')}
        style={{ ...field, border: `1px solid ${state?.error ? '#E5A3A3' : '#34343A'}` }}
      />
      <label style={{ ...label, display: 'block', marginTop: 16 }} htmlFor="demo_concept">{t('Your concept', 'Tu concepto')}</label>
      <select
        id="demo_concept"
        name="concept"
        value={concept}
        onChange={(e) => setConcept(e.target.value)}
        style={{ ...field, border: '1px solid #34343A' }}
      >
        {CONCEPTS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>

      {/* Honeypot — invisible to real users (display:none AND
          tabIndex=-1 AND autocomplete=off AND aria-hidden). Bots
          that fill every field will set this and trip the server
          filter. NEVER add a real label or place it where a user
          could see/focus it. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      />

      <div style={{ fontSize: 12.5, color: '#E5A3A3', height: 16, marginTop: 9, opacity: state?.error ? 1 : 0 }}>
        {state?.error ?? ''}
      </div>
      <button
        type="submit"
        disabled={pending}
        style={{
          width: '100%', marginTop: 6,
          cursor: pending ? 'default' : 'pointer',
          background: '#FAF9F6', color: '#18181B', border: 'none',
          fontSize: 16, fontWeight: 600, fontFamily: 'inherit',
          padding: 15, borderRadius: 11,
          opacity: pending ? 0.7 : 1,
        }}
      >
        {pending
          ? t('Sending…', 'Enviando…')
          : t('Book my demo →', 'Agendar mi demo →')}
      </button>
      <p style={{ fontSize: 11.5, color: '#6B6B70', textAlign: 'center', margin: '14px 0 0', lineHeight: 1.5 }}>{t(
        'No spam. I read every one of these myself.',
        'Sin spam. Yo leo cada uno personalmente.'
      )}</p>
    </form>
  )
}
