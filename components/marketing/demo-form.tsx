'use client'

// ----------------------------------------------------------------
// DemoForm — "Book a demo" capture for the marketing CTA.
// Client component (local state + validation).
//
// ⚠ LEAD DELIVERY IS NOT WIRED YET — see the TODO in submit().
//
// The form validates and shows the success state, but the captured
// { email, concept } payload currently goes nowhere. Wire delivery
// when the production domain + email address are ready. Two clean
// options when that day comes:
//
//   1. Supabase — INSERT into a `demo_requests` table. Read leads
//      in the Supabase dashboard. Zero new services.
//   2. Resend (or similar) — send the lead to demos@checked.app
//      via a server action. Free tier covers 3,000 emails/month.
//
// Recommended path: do BOTH — Supabase as the durable record, email
// as the instant notification.
// ----------------------------------------------------------------

import { useState } from 'react'
import type { CSSProperties } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'

const CONCEPTS_EN = [
  'Taqueria / tacos', 'Mariscos', 'Panadería / bakery', 'BBQ',
  'Breakfast / cafe', 'Burgers', 'Other',
]
const CONCEPTS_ES = [
  'Taquería / tacos', 'Mariscos', 'Panadería', 'BBQ',
  'Desayunos / café', 'Hamburguesas', 'Otro',
]

interface Props {
  lang?: 'en' | 'es'
}

export default function DemoForm({ lang = 'en' }: Props) {
  const t = (en: string, es?: string): string => (lang === 'es' && es ? es : en)
  const CONCEPTS = lang === 'es' ? CONCEPTS_ES : CONCEPTS_EN
  const [email, setEmail] = useState('')
  const [concept, setConcept] = useState(CONCEPTS[0])
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const submit = () => {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    if (!ok) { setError(t('Enter a valid email so I can reach you.', 'Pon un correo válido para poder contactarte.')); return }
    // TODO(LEAD-DELIVERY): wire { email, concept } to Supabase + email.
    //   See the file-level note above for the recommended path. Today
    //   this submission shows the success screen but the payload is
    //   not persisted or forwarded anywhere.
    setSubmitted(true)
  }

  const label: CSSProperties = {
    fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6B70',
  }
  const field: CSSProperties = {
    width: '100%', marginTop: 8, background: '#18181B', color: '#FAF9F6', fontSize: 15,
    fontFamily: 'inherit', padding: '13px 14px', borderRadius: 10, outline: 'none',
  }

  if (submitted) {
    return (
      <div style={{ flex: '1 1 360px', background: '#232327', border: '1px solid #34343A', borderRadius: 18, padding: 26 }}>
        <div style={{ textAlign: 'center', padding: '24px 8px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: '50%', background: '#FAF9F6', color: '#18181B', fontSize: 24 }}>✓</div>
          <div style={{ fontSize: 21, fontWeight: 700, marginTop: 18 }}>{t('You’re on the list.', 'Ya quedaste en la lista.')}</div>
          <p style={{ fontSize: 15, color: '#C9C9CE', margin: '10px 0 0', lineHeight: 1.5 }}>{t(
            'I’ll reach out within a day to set up your demo. Talk soon. — Renato Ruiz',
            'Te contacto en menos de un día para agendar tu demo. Hablamos pronto. — Renato Ruiz'
          )}</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: '1 1 360px', background: '#232327', border: '1px solid #34343A', borderRadius: 18, padding: 26 }}>
      <label style={label}>{t('Your email', 'Tu correo')}</label>
      <input
        type="email"
        value={email}
        onChange={(e) => { setEmail(e.target.value); setError('') }}
        placeholder={t('you@yourrestaurant.com', 'tu@turestaurante.com')}
        style={{ ...field, border: `1px solid ${error ? '#E5A3A3' : '#34343A'}` }}
      />
      <label style={{ ...label, display: 'block', marginTop: 16 }}>{t('Your concept', 'Tu concepto')}</label>
      <select value={concept} onChange={(e) => setConcept(e.target.value)} style={{ ...field, border: '1px solid #34343A' }}>
        {CONCEPTS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <div style={{ fontSize: 12.5, color: '#E5A3A3', height: 16, marginTop: 9, opacity: error ? 1 : 0 }}>{error}</div>
      <button onClick={submit} style={{ width: '100%', marginTop: 6, cursor: 'pointer', background: '#FAF9F6', color: '#18181B', border: 'none', fontSize: 16, fontWeight: 600, fontFamily: 'inherit', padding: 15, borderRadius: 11 }}>
        {t('Book my demo →', 'Agendar mi demo →')}
      </button>
      <p style={{ fontSize: 11.5, color: '#6B6B70', textAlign: 'center', margin: '14px 0 0', lineHeight: 1.5 }}>{t(
        'No spam. I read every one of these myself.',
        'Sin spam. Yo leo cada uno personalmente.'
      )}</p>
    </div>
  )
}
