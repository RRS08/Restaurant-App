// ----------------------------------------------------------------
// Marketing landing page — checked.app/
//
// Server component. Renders the marketing site and mounts client
// islands: <FloorSim />, <DemoForm />, <LanguageToggle />.
//
// Bilingual via cookie + Accept-Language detection. The user's
// preference is stored in a `lang` cookie set by LanguageToggle.
// On the first visit (no cookie) we fall back to the browser's
// Accept-Language header. English is the default for anything we
// can't infer.
//
// Type texture: Geist Sans (inherited from app/layout body) + Geist
// Mono via the MONO var for the "ledger" eyebrows and figures.
// ----------------------------------------------------------------

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { cookies, headers } from 'next/headers'
import { BrandLockup } from '@/components/brand'
import FloorSim from '@/components/marketing/floor-sim'
import DemoForm from '@/components/marketing/demo-form'
import ProblemCards from '@/components/marketing/problem-cards'
import LanguageToggle from '@/components/marketing/language-toggle'

type Lang = 'en' | 'es'

// Resolves the active language for this request. Cookie wins (the
// user made an explicit choice via the toggle). Otherwise we peek
// at Accept-Language — if it leads with "es", show Spanish. Else
// English. Anything unrecognized defaults to English.
async function resolveLanguage(): Promise<Lang> {
  const c = await cookies()
  const cookieLang = c.get('lang')?.value
  if (cookieLang === 'en' || cookieLang === 'es') return cookieLang

  const h = await headers()
  const accept = (h.get('accept-language') ?? '').toLowerCase().trim()
  if (accept.startsWith('es')) return 'es'
  return 'en'
}

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })

const wrap = (extra: CSSProperties = {}): CSSProperties => ({ maxWidth: 1160, margin: '0 auto', ...extra })
const eyebrow: CSSProperties = { ...mono(), fontSize: 11.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6B6B70' }
// Act numbers anchor each section as a chapter marker. Clamped
// so 01/02/03 scale down on mobile (where the H2 next to them
// shrinks to ~26px) — without the clamp a fixed 64px act number
// looms awkwardly over a 26px headline on a phone.
const actNum: CSSProperties = { ...mono(), fontSize: 'clamp(44px, 6vw, 64px)', fontWeight: 600, lineHeight: 1, color: '#18181B' }
const card: CSSProperties = { background: '#FFFFFF', border: '1px solid #E7E6E2', borderRadius: 14 }

// Entry-animation helpers — keyframes live in the page's <style>
// block. `backwards` keeps the element at the `from` state during
// the delay so nothing flashes before its turn. prefers-reduced-
// motion disables the animations entirely.
const enter = (delay: number): CSSProperties => ({
  animation: `mkFadeUp 700ms cubic-bezier(0.22, 0.7, 0.2, 1) ${delay}ms backwards`,
})
// True typewriter reveal — clip-path wipes the element from left
// to right so the text feels like it's being printed across the
// ticket. Works on any layout (justify-between rows, centered text)
// because it's visual clipping, not a width change.
const typeIn = (delay: number, duration = 420): CSSProperties => ({
  animation: `mkTypeReveal ${duration}ms cubic-bezier(0.22, 0.7, 0.2, 1) ${delay}ms backwards`,
})
const popIn = (delay: number): CSSProperties => ({
  animation: `mkPop 480ms cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}ms backwards`,
})

// NOTE: PILOT, SETUP, PRINCIPLES, TESTIMONIALS arrays are declared
// inside MarketingPage so they can use the request-scoped `t()`
// helper for inline translation.

function TestimonialCard({ q, who, city }: { q: string; who: string; city: string }) {
  return (
    <div style={{ flex: '0 0 300px', width: 300, marginRight: 14, background: '#FFFFFF', border: '1px dashed #D8D8D4', borderRadius: 16, padding: 24, minHeight: 188, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
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

export default async function MarketingPage() {
  const lang = await resolveLanguage()
  // Translation helper. First arg is English (default fallback).
  // Second arg is Spanish — if omitted, the English string is used
  // in both languages. Lets us roll out translations incrementally
  // without leaving holes that crash the page.
  const t = (en: string, es?: string): string => (lang === 'es' && es ? es : en)

  const PILOT = [
    {
      t: t('Your money never touches us.', 'Tu dinero nunca pasa por nosotros.'),
      d: t(
        'Card payments flow through Stripe directly to your bank account. We can\'t hold your money for a single hour — by design. Stripe handles the processing, fraud protection, and payouts. We just write the line item.',
        'Los pagos con tarjeta van por Stripe directo a tu cuenta de banco. No podemos retener tu dinero ni una hora — por diseño. Stripe procesa, protege contra fraude y deposita. Nosotros solo registramos la venta.'
      ),
    },
    {
      t: t('Your bank stays your bank.', 'Tu banco sigue siendo tu banco.'),
      d: t(
        'Plaid connections are read-only. We see transactions so we can reconcile your spend. We can\'t move money, and we never see your password. Disconnect from settings, any time.',
        'Las conexiones con Plaid son de solo lectura. Vemos las transacciones para conciliar gastos. No podemos mover dinero, y nunca vemos tu contraseña. Desconectas desde Ajustes, cuando quieras.'
      ),
    },
    {
      t: t('Every number is traceable.', 'Cada número se puede rastrear.'),
      d: t(
        'Every sale, void, shift edit, and menu change writes to a permanent audit log. If a number looks wrong, you can see exactly where it came from. No "trust us" — the receipts are there.',
        'Cada venta, cancelación, cambio de turno y ajuste de menú queda en un registro permanente. Si un número se ve raro, puedes ver exactamente de dónde salió. Sin “confía en nosotros” — los recibos están ahí.'
      ),
    },
    {
      t: t('Your data is yours — always.', 'Tu información es tuya — siempre.'),
      d: t(
        'Walled off from every other restaurant by row-level security. Encrypted at rest and in transit. Exportable any time, with no friction. If Checked ever closes its doors, you take everything with you.',
        'Aislada de cualquier otro restaurante con seguridad a nivel de fila. Encriptada en reposo y en tránsito. Exportable cuando quieras, sin trabas. Si algún día Checked cierra, te llevas todo contigo.'
      ),
    },
  ]

  const SETUP = [
    {
      n: '01',
      t: t('We show up', 'Llegamos contigo'),
      d: t('In person or on a call. The founder, not a rollout queue.', 'En persona o por llamada. El fundador, no una fila de soporte.'),
      last: false,
    },
    {
      n: '02',
      t: t('We set you up', 'Te dejamos listo'),
      d: t(
        'Menu, inventory, shifts, roles — we load it together so you don’t have to learn the system before you can use it.',
        'Menú, inventario, turnos, roles — lo cargamos juntos para que no tengas que aprenderte el sistema antes de poder usarlo.'
      ),
      last: false,
    },
    {
      n: '03',
      t: t('First service, together', 'Primer servicio, juntos'),
      d: t(
        'We’re on the line for your first lunch. Tickets fly, quirks get caught, fixes happen live.',
        'Estamos contigo en tu primer servicio. Vuelan las comandas, se detectan los detalles, los arreglos pasan en vivo.'
      ),
      last: false,
    },
    {
      n: '04',
      t: t('We keep showing up', 'Seguimos contigo'),
      d: t(
        'Same phone, same person, same response. The day we install isn’t the day we leave.',
        'Mismo teléfono, misma persona, misma respuesta. El día que te instalamos no es el día que nos vamos.'
      ),
      last: true,
    },
  ]

  const PRINCIPLES = [
    {
      n: '01',
      t: t('Value first.', 'Primero el valor.'),
      d: t(
        'The product has to earn its keep before it asks for a dollar. Revenue is what happens when a real problem gets solved well — not the other way around.',
        'El producto se tiene que ganar el lugar antes de pedir un dólar. El ingreso es lo que pasa cuando se resuelve bien un problema real — no al revés.'
      ),
    },
    {
      n: '02',
      t: t('Radical transparency.', 'Transparencia radical.'),
      d: t(
        'Honest terms, and what it can’t do yet — said out loud. If you ever want to leave, it’s one click, not a phone tree.',
        'Términos honestos, y lo que aún no hace — dicho de frente. Si algún día te quieres ir, es un clic, no un menú de llamadas.'
      ),
    },
    {
      n: '03',
      t: t('You’re a partner, not a ticket.', 'Eres un socio, no un ticket de soporte.'),
      d: t(
        'Your wins are my wins. However big this gets, you stay heard, supported, and one message away from the person who built it.',
        'Tus ganancias son mis ganancias. Sin importar qué tanto crezca esto, sigues escuchado, respaldado y a un mensaje de la persona que lo construyó.'
      ),
    },
    {
      n: '04',
      t: t('Right fit only.', 'Solo si funciona.'),
      d: t(
        'We work together when it’s a fit for both sides. If it’s not, finding that out early beats finding out later.',
        'Trabajamos juntos cuando es un buen encaje para ambos. Si no lo es, mejor descubrirlo temprano que tarde.'
      ),
    },
  ]

  const TESTIMONIALS = [
    {
      q: t(
        'A pilot partner’s words go here — what changed once every number finally agreed.',
        'Aquí van las palabras de un socio piloto — qué cambió cuando por fin todos los números cuadraron.'
      ),
      who: t('[Owner] · [Taqueria]', '[Dueño] · [Taquería]'),
      city: t('[City]', '[Ciudad]'),
    },
    {
      q: t(
        'A pilot partner’s words go here — the Sunday night they stopped reconstructing the week by hand.',
        'Aquí van las palabras de un socio piloto — el domingo en la noche que dejaron de armar la semana a mano.'
      ),
      who: t('[Owner] · [Mariscos]', '[Dueño] · [Mariscos]'),
      city: t('[City]', '[Ciudad]'),
    },
    {
      q: t(
        'A pilot partner’s words go here — the first lunch rush they didn’t run out of anything.',
        'Aquí van las palabras de un socio piloto — la primera hora pico donde no se les acabó nada.'
      ),
      who: t('[Owner] · [Bakery]', '[Dueño] · [Panadería]'),
      city: t('[City]', '[Ciudad]'),
    },
    {
      q: t(
        'A pilot partner’s words go here — live the same afternoon, on the iPad they already had.',
        'Aquí van las palabras de un socio piloto — en vivo la misma tarde, en la tableta que ya tenían.'
      ),
      who: t('[Owner] · [BBQ]', '[Dueño] · [BBQ]'),
      city: t('[City]', '[Ciudad]'),
    },
    {
      q: t(
        'A pilot partner’s words go here — finally seeing the real margin, in real time.',
        'Aquí van las palabras de un socio piloto — por fin viendo el margen real, en tiempo real.'
      ),
      who: t('[Owner] · [Cafe]', '[Dueño] · [Café]'),
      city: t('[City]', '[Ciudad]'),
    },
  ]

  return (
    <div style={{ background: '#FAF9F6', color: '#18181B', minHeight: '100vh' }}>
      <style>{`
        @keyframes cPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
        @keyframes testiScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
        @keyframes fadeMerge{0%,100%{opacity:1;transform:translateX(0)}58%{opacity:.2;transform:translateX(16px)}}
        @keyframes arrowPulse{0%,100%{opacity:.35}50%{opacity:1}}
        /* Page-entry animations.
           mkFadeUp:     hero text + receipt frame — rise 12px while fading.
           mkTypeReveal: each receipt line wipes in from the left as if
                         being printed across the paper. Uses clip-path
                         so it doesn't disturb layout (justify-between
                         rows keep their flex spacing).
           mkPop:        the "reconciled" check mark — small overshoot pop. */
        @keyframes mkFadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        @keyframes mkTypeReveal{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
        @keyframes mkPop{0%{opacity:0;transform:scale(0.5)}60%{opacity:1;transform:scale(1.15)}100%{opacity:1;transform:scale(1)}}
        /* Respect reduced-motion preference — no entrance animations,
           no pulses, no marquee. The page just appears, fully formed. */
        @media (prefers-reduced-motion: reduce){
          *,*::before,*::after{animation:none!important;transition:none!important}
        }
        /* Smooth-scroll anchor links — clicking The Platform / The
           Difference / Our Commitment / Book a demo glides to the
           target section instead of snapping. The scroll-margin keeps
           each section's heading clear of the sticky nav bar. */
        html{scroll-behavior:smooth}
        .mk-marquee:hover{animation-play-state:paused}
        .mk-sec{scroll-margin-top:96px}

        /* ============================================================
           Mobile redesign — single breakpoint at 640px. The page is
           already wrap-friendly via clamp() font sizes and flex 1 1
           basis values; mobile-only tightening focuses on the three
           areas that don't degrade gracefully:
             1. Nav row — secondary links hide on phone; the signup
                button and "Book a demo" CTA stay reachable.
             2. Hero — section padding + min-height shrink so the
                receipt motif doesn't get pushed below the fold; the
                receipt itself caps its width so it doesn't overflow.
             3. Section padding — Act 2/3 + dark setup card lose
                their desktop-sized vertical padding.
           Plus a few small fixes for sections where the desktop flex
           gap is too tight or too wide for phone width.
           ============================================================ */
        @media (max-width: 640px){
          /* Nav — hide deep-section links; keep brand, Book a demo,
             Sign up. A real phone visitor doesn't need 4 anchor
             links — they scroll, and the CTA is always one tap
             away via the Book a demo link. */
          .mk-nav-row{padding:11px 18px!important;gap:10px!important}
          .mk-nav-links{gap:14px!important}
          .mk-nav-deep{display:none!important}
          .mk-nav-cta{font-size:13px!important;padding:8px 13px!important}

          /* Hero — tighter side padding, shorter min-height so the
             receipt sits in view without scrolling. The clamp() on
             the h1 already handles type sizing. */
          .mk-hero{padding:28px 18px 32px!important;min-height:auto!important}
          .mk-hero-grid{gap:32px!important}
          .mk-hero-receipt{max-width:320px!important;margin:0 auto!important}
          .mk-hero-p{font-size:16.5px!important;line-height:1.55!important}
          .mk-hero-cta{padding:14px 22px!important;font-size:15.5px!important}

          /* Section padding — Act 1/2/3, pilot, testimonials,
             principles all share generous vertical padding by
             default; halve it on phone. */
          .mk-section{padding-left:18px!important;padding-right:18px!important}
          .mk-act-pad-top{padding-top:56px!important}
          .mk-act-pad-bottom{padding-bottom:24px!important}

          /* Act 2 One/One/One — the title and description sit
             side-by-side on desktop; on mobile they stack with
             extra row padding for breathing room. */
          .mk-act2-row{gap:8px!important;padding:18px 0!important}
          .mk-act2-row-title{min-width:0!important}

          /* Dark setup card — tighter padding so the four step
             tiles don't get cramped between the wall and the
             edge of the card. */
          .mk-setup-card{padding:24px!important}
          .mk-setup-head{flex-direction:column!important;align-items:flex-start!important;gap:14px!important;margin-bottom:24px!important}

          /* Final CTA — stack form below text; tighter padding. */
          .mk-cta-section{padding:60px 18px!important}
          .mk-cta-grid{gap:32px!important}

          /* Footer — center-align on phone so the brand + tagline
             + copyright stack vertically. */
          .mk-footer{flex-direction:column!important;text-align:center!important;gap:10px!important;padding:28px 18px 38px!important}

          /* Language toggle — slightly smaller and tucked further
             into the corner so it doesn't sit over the CTA. */
          .mk-lang-toggle{bottom:14px!important;right:14px!important}
        }
      `}</style>

      {/* NAV */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 50, backdropFilter: 'saturate(1.4) blur(10px)', background: 'rgba(250,249,246,0.82)', borderBottom: '1px solid #E7E6E2' }}>
        <div className="mk-nav-row" style={wrap({ padding: '13px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' })}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}><BrandLockup size="md" /></Link>
          <div className="mk-nav-links" style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
            <a className="mk-nav-deep" href="#what" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>{t('The Platform', 'La Plataforma')}</a>
            <a className="mk-nav-deep" href="#why" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>{t('The Difference', 'La Diferencia')}</a>
            <a className="mk-nav-deep" href="#trust" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>{t('Our Commitment', 'Nuestro Compromiso')}</a>
            <a href="#book" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>{t('Book a demo', 'Pide una demo')}</a>
            <Link className="mk-nav-cta" href="/signup" style={{ background: '#18181B', color: '#FAF9F6', textDecoration: 'none', fontSize: 14, fontWeight: 600, padding: '9px 17px', borderRadius: 9 }}>{t('Sign up', 'Crear cuenta')}</Link>
          </div>
        </div>
      </nav>

      {/* HERO — fills the viewport below the nav so Act 1 sits
          deliberately below the fold. The user has to scroll to
          reach the first section, which gives the entrance
          animation room to land and naturally separates the
          marketing tagline from the rest of the page. */}
      <section className="mk-hero" style={wrap({ padding: '40px 24px', minHeight: 'calc(100vh - 60px)', display: 'flex', alignItems: 'center' })}>
        <div className="mk-hero-grid" style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 48, alignItems: 'center' }}>
          <div style={{ flex: '1 1 440px' }}>
            <div style={{ ...eyebrow, ...enter(0) }}>{t('Daily operating system · Made for owners', 'Sistema operativo del día · Hecho para dueños')}</div>
            <h1 style={{ fontSize: 'clamp(38px,5.4vw,66px)', lineHeight: 0.98, letterSpacing: '-2.2px', fontWeight: 700, margin: '22px 0 0', ...enter(120) }}>{t('Run the whole place from the counter you’re already standing at.', 'Maneja todo tu lugar desde el mostrador donde ya estás parado.')}</h1>
            <p className="mk-hero-p" style={{ fontSize: 19, lineHeight: 1.55, color: '#52525B', maxWidth: 500, margin: '24px 0 0', ...enter(260) }}>{t('Checked is the operating system independent restaurants have been waiting for — POS, inventory, staffing, finance, and analytics on one screen, one bill, and the tablet you already own. One ring moves your stock, your cash, and your books at the same time. So “what happened today” stops being a Sunday-night guess with a calculator and a shoebox of receipts.', 'Checked es el sistema operativo que los restaurantes independientes estaban esperando — POS, inventario, personal, finanzas y analíticas en una sola pantalla, una sola cuenta, y la tableta que ya tienes. Una venta mueve tu inventario, tu dinero y tus libros al mismo tiempo. Así “qué pasó hoy” deja de ser una adivinanza del domingo en la noche con una calculadora y una caja de recibos.')}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 30, ...enter(400) }}>
              <Link className="mk-hero-cta" href="/signup" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: '#18181B', color: '#FAF9F6', textDecoration: 'none', fontSize: 16, fontWeight: 600, padding: '15px 26px', borderRadius: 11 }}>{t('Get started', 'Empezar')} <span style={mono()}>&rarr;</span></Link>
              <a className="mk-hero-cta" href="#book" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: 'transparent', color: '#18181B', textDecoration: 'none', fontSize: 16, fontWeight: 600, padding: '15px 22px', borderRadius: 11, border: '1px solid #D8D8D4' }}>{t('Book a demo', 'Pide una demo')}</a>
            </div>
            <div style={mono({ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 26, fontSize: 12.5, color: '#6B6B70', ...enter(540) })}>
              <span>{t('Owner-operator first', 'Hecho para dueños')}</span><span style={{ color: '#D0D0CC' }}>·</span>
              <span>{t('Easy to install', 'Fácil de instalar')}</span><span style={{ color: '#D0D0CC' }}>·</span>
              <span>{t('Built to make sense', 'Sin complicaciones')}</span>
            </div>
          </div>

          {/* receipt motif — physical printer cadence: paper slides
              in empty, then each section types itself out, with
              brief pauses between sections so it reads as
              "printer block 1 → pause → printer block 2 → pause".
              Cadence (delay / wipe-duration):
                280  / 700  paper slides in
                1100 / 800  TACOS DON PORK + timestamp        (section 1)
                — 90ms pause —
                1990 / 500  2× Tacos al Pastor                 (section 2)
                2590 / 500  1× Quesabirria
                3190 / 500  1× Horchata
                — 100ms pause —
                3790 / 550  Stock updated · −3 ingredients     (section 3)
                4440 / 500  TOTAL · $15.25
                — 100ms pause —
                5040 / 700  Next morning · reconciled          (section 4)
                5840        ✓ check mark pops                                 */}
          <div className="mk-hero-receipt" style={{ flex: '0 1 300px', minWidth: 260, margin: '0 auto', ...enter(280) }}>
            <div style={mono({ background: '#FFFFFF', border: '1px solid #E7E6E2', borderRadius: '14px 14px 0 0', boxShadow: '0 28px 60px -32px rgba(24,24,27,0.30)', padding: 22, color: '#18181B' })}>
              <div style={{ textAlign: 'center', borderBottom: '1px dashed #D8D8D4', paddingBottom: 14, ...typeIn(1100, 800) }}>
                <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: 1 }}>{lang === 'es' ? 'TACOS DON PORK' : 'PORK’S BURGERS'}</div>
                <div style={{ fontSize: 10.5, color: '#A1A1A6', marginTop: 3 }}>{lang === 'es' ? 'Mar 14 · 1:24 PM · Caja 1' : 'Mar 14 · 1:24 PM · Counter 1'}</div>
              </div>
              <div style={{ fontSize: 12.5, padding: '14px 0', display: 'flex', flexDirection: 'column', gap: 9 }}>
                {lang === 'es' ? (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(1990, 500) }}><span>2× Tacos al Pastor</span><span>7.00</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(2590, 500) }}><span>1× Quesabirria</span><span>4.75</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(3190, 500) }}><span>1× Horchata</span><span>3.50</span></div>
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(1990, 500) }}><span>2× Smash Burger</span><span>7.00</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(2590, 500) }}><span>1× Bacon Stack</span><span>4.75</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(3190, 500) }}><span>1× Lemonade</span><span>3.50</span></div>
                  </>
                )}
              </div>
              <div style={{ borderTop: '1px dashed #D8D8D4', padding: '13px 0 0', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B6B70', ...typeIn(3790, 550) }}><span>{t('Stock updated', 'Inventario actualizado')}</span><span style={{ color: '#18181B' }}>{t('−3 ingredients', '−3 ingredientes')}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600, ...typeIn(4440, 500) }}><span>TOTAL</span><span>$15.25</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, paddingTop: 12, borderTop: '1px dashed #D8D8D4', ...typeIn(5040, 700) }}>
                  <span style={{ color: '#6B6B70' }}>{t('Next morning', 'A la mañana siguiente')}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{t('reconciled', 'conciliado')} <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: '#18181B', color: '#FFF', fontSize: 10, ...popIn(5840) }}>✓</span></span>
                </div>
              </div>
            </div>
            <div style={{ height: 11, background: '#FFFFFF', clipPath: 'polygon(0 0,8.33% 100%,16.66% 0,25% 100%,33.33% 0,41.66% 100%,50% 0,58.33% 100%,66.66% 0,75% 100%,83.33% 0,91.66% 100%,100% 0)' }} />
          </div>
        </div>
      </section>

      {/* ACT 1 — slightly tighter top padding (64 vs Acts 2/3's
          96) because the hero above is full-viewport with vertically
          centered content. The hero's empty bottom space already
          contributes breathing room before this section starts. */}
      <section id="what" className="mk-sec mk-section mk-act-pad-top mk-act-pad-bottom" style={wrap({ padding: '64px 24px 32px' })}>
        <div style={{ borderTop: '1px solid #18181B', paddingTop: 36, display: 'flex', alignItems: 'baseline', gap: 28, flexWrap: 'wrap' }}>
          <span style={actNum}>01</span>
          <div>
            <div style={eyebrow}>{t('What it is & what it fixes', 'Qué es y qué arregla')}</div>
            <h2 style={{ fontSize: 'clamp(26px,3.4vw,40px)', lineHeight: 1.05, letterSpacing: '-1.3px', fontWeight: 700, margin: '8px 0 0', maxWidth: 760 }}>{t('Your tools don’t talk to each other. Checked makes them one screen.', 'Tus herramientas no se hablan entre sí. Checked las une en una sola pantalla.')}</h2>
          </div>
        </div>
      </section>

      {/* problem */}
      <section className="mk-section" style={wrap({ padding: '36px 24px 8px' })}>
        <p style={{ fontSize: 17, lineHeight: 1.55, color: '#52525B', margin: '0 0 44px', maxWidth: 620 }}>{t(
          'An independent restaurant runs on five different things at once — sales at the counter, labor on the schedule, inventory in the walk-in, money in the bank, and your head holding all of it together. None of them talk to each other. So stock gets tracked by hand until you run out of your bestseller in the middle of the rush. Money never quite squares because credits, invoices, delayed payouts, and payroll all live somewhere different. And the real picture — how today\'s sales actually compared to today\'s labor and today\'s stock burn — gets stitched together by hand in a spreadsheet at 11 PM on a Sunday. That\'s the mess Checked replaces. Not by being one more app, but by making one screen where a sale moves inventory, inventory moves finance, and finance answers the question you actually have: am I making money tonight.',
          'Un restaurante independiente corre con cinco cosas a la vez — ventas en la caja, personal en el horario, inventario en la cocina, dinero en el banco, y tu cabeza aguantando todo. Ninguno se habla con el otro. Por eso el inventario se lleva a mano hasta que se acaba tu platillo estrella en plena hora pico. El dinero nunca cuadra del todo porque las propinas, las facturas, los depósitos atrasados y la nómina viven cada uno por su lado. Y la foto real — cómo se compararon de verdad las ventas de hoy contra el costo de mano de obra y el consumo de inventario — la armas a mano en una hoja de cálculo a las 11 PM un domingo. Ese es el desorden que Checked reemplaza. No siendo una app más, sino haciendo una sola pantalla donde una venta mueve el inventario, el inventario mueve las finanzas, y las finanzas responden la pregunta que de verdad tienes: ¿estoy ganando dinero esta noche?'
        )}</p>
        <ProblemCards />
      </section>

      {/* live demo — extra top padding so the pivot from "five
          disconnected problems" (ProblemCards above) to "one
          unified solution" (FloorSim below) reads as a deliberate
          section break, not a continuation. */}
      <section className="mk-section mk-act-pad-top mk-act-pad-bottom" style={wrap({ padding: '96px 24px 64px' })}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
          <h3 style={{ fontSize: 'clamp(22px,2.8vw,32px)', lineHeight: 1.08, letterSpacing: '-1px', fontWeight: 700, margin: 0, maxWidth: 620 }}>{t(
            'Here’s what that looks like in motion. The same restaurant, on one screen, across one real day.',
            'Así se ve en movimiento. El mismo restaurante, en una sola pantalla, a lo largo de un día real.'
          )}</h3>
          <p style={mono({ fontSize: 12.5, color: '#6B6B70', maxWidth: 240, lineHeight: 1.6 })}>{t(
            'The actual product, not a mockup. Plays itself as you scroll — three moments, from a single ring to close.',
            'El producto real, no una maqueta. Se reproduce solo conforme bajas — tres momentos, desde la primera venta hasta el cierre.'
          )}</p>
        </div>
        <FloorSim lang={lang} />
      </section>

      {/* ACT 2 */}
      <section id="why" className="mk-sec" style={{ background: '#F0F0EC' }}>
        <div className="mk-section mk-act-pad-top mk-act-pad-bottom" style={wrap({ padding: '96px 24px 32px' })}>
          <div style={{ borderTop: '1px solid #18181B', paddingTop: 36, display: 'flex', alignItems: 'baseline', gap: 28, flexWrap: 'wrap' }}>
            <span style={actNum}>02</span>
            <div>
              <div style={eyebrow}>{t('Why get it from us', 'Por qué con nosotros')}</div>
              <h2 style={{ fontSize: 'clamp(26px,3.4vw,40px)', lineHeight: 1.05, letterSpacing: '-1.3px', fontWeight: 700, margin: '8px 0 0', maxWidth: 760 }}>{t('Same software. Same price. Same person. For as long as we work together.', 'Mismo software. Mismo precio. Misma persona. Mientras trabajemos juntos.')}</h2>
              <p style={{ fontSize: 17, lineHeight: 1.55, color: '#52525B', margin: '20px 0 0', maxWidth: 700 }}>{t(
                'Independent restaurants get underserved, expected to figure out software no one ever explained to them, and overcharged by every alternative on the market. Checked is built to be the opposite.',
                'Los restaurantes independientes están desatendidos, se espera que entiendan un software que nadie les explicó, y los sobrecobra cualquier alternativa del mercado. Checked está hecho para ser lo opuesto.'
              )}</p>
            </div>
          </div>
        </div>

        <div className="mk-section" style={wrap({ padding: '34px 24px 0' })}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['POS', 'Spreadsheet', 'Notebook', 'Bank app', 'Whiteboard'].map((x, i) => (
                <span key={x} style={{ fontSize: 11, color: '#A1A1A6', background: '#FFFFFF', border: '1px dashed #D8D8D4', borderRadius: 7, padding: '5px 9px', animation: `fadeMerge 3.2s ease-in-out infinite`, animationDelay: `${i * 0.15}s` }}>{x}</span>
              ))}
            </div>
            <span style={mono({ fontSize: 18, color: '#18181B', animation: 'arrowPulse 3.2s ease-in-out infinite' })}>&rarr;</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#18181B', color: '#FAF9F6', borderRadius: 9, padding: '6px 12px', fontSize: 12, fontWeight: 600 }}>
              <svg width="14" height="14" viewBox="0 0 24 24"><path d="M5 12l5 5 9-11" fill="none" stroke="#FAF9F6" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>One screen
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 16 }}>
            {[
              {
                t: t('One package.', 'Un solo paquete.'),
                d: t(
                  'Everything your floor needs — POS, inventory, staffing, finance, analytics — on one screen and one bill. No starter tier with the essentials sold back as add-ons. No fees that creep up over time. No locked hardware. One price. What you see is what you pay, for as long as we work together.',
                  'Todo lo que tu piso necesita — POS, inventario, personal, finanzas, analíticas — en una sola pantalla y una sola cuenta. Sin un plan básico que te vende lo esencial como extras. Sin cargos que suben con el tiempo. Sin hardware bloqueado. Un solo precio. Lo que ves es lo que pagas, mientras trabajemos juntos.'
                ),
                bottom: false,
              },
              {
                t: t('One promise.', 'Una sola promesa.'),
                d: t(
                  'The day you’re installed isn’t the last day we show up. The price you signed up at stays. Cancellation is one click, not a phone tree. New features get built because you asked for them, not because we needed a new tier to charge for. We earn growth by serving you better — not by squeezing more out of you.',
                  'El día que te instalamos no es el último día que nos ves. El precio con el que entras se queda. Cancelar es un clic, no un menú telefónico. Las funciones nuevas las hacemos porque tú las pediste, no porque necesitamos un plan nuevo que cobrarte. Crecemos sirviéndote mejor — no exprimiéndote más.'
                ),
                bottom: false,
              },
              {
                t: t('One person.', 'Una sola persona.'),
                d: t(
                  'You reach a human — the founder who built this. If your kitchen ticket printer dies during dinner service, you call me and I pick up. That’s the part of the company we’ll never outgrow.',
                  'Te contesta una persona — el fundador que construyó esto. Si la impresora de comandas muere en plena cena, me llamas y contesto. Esa parte de la empresa nunca la vamos a perder.'
                ),
                bottom: true,
              },
            ].map((row) => (
              <div key={row.t} className="mk-act2-row" style={{ display: 'flex', gap: 'clamp(16px,4vw,44px)', flexWrap: 'wrap', alignItems: 'baseline', borderTop: '1px solid #E2E0DA', borderBottom: row.bottom ? '1px solid #E2E0DA' : undefined, padding: '24px 0' }}>
                <div className="mk-act2-row-title" style={{ flex: '0 0 clamp(260px,22vw,320px)', fontSize: 'clamp(34px,5vw,56px)', fontWeight: 700, letterSpacing: '-2.2px', lineHeight: 0.92 }}>{row.t}</div>
                <p style={{ flex: '1 1 320px', fontSize: 17, lineHeight: 1.5, color: '#52525B', margin: 0 }}>{row.d}</p>
              </div>
            ))}
          </div>
        </div>

        {/* setup speed — extra top padding so the dark mode change
            from cream Act 2 surface lands as its own beat, not a
            mid-section interruption. */}
        <div className="mk-section mk-act-pad-bottom" style={wrap({ padding: '88px 24px 64px' })}>
          <div className="mk-setup-card" style={{ background: '#18181B', color: '#FAF9F6', borderRadius: 18, padding: 'clamp(28px,4vw,44px)' }}>
            <div className="mk-setup-head" style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 32px', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 32 }}>
              <div>
                <div style={mono({ fontSize: 11.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#A1A1A6' })}>{t('Setup, done together', 'Instalación, juntos')}</div>
                <h3 style={{ fontSize: 'clamp(24px,3.2vw,38px)', lineHeight: 1.05, letterSpacing: '-1.2px', fontWeight: 700, margin: '14px 0 0', maxWidth: 620 }}>{t('Setup isn’t a project. It’s where the partnership starts.', 'La instalación no es un proyecto. Es donde empieza nuestra relación.')}</h3>
              </div>
              <p style={{ fontSize: 15, lineHeight: 1.55, color: '#C9C9CE', maxWidth: 300, margin: 0 }}>{t(
                'No rollout team you’ll never speak to again. No implementation fee. No consultant on a clock. Just the person who built this, sitting with you while you go live.',
                'Sin un equipo de instalación al que nunca vuelves a hablarle. Sin cuota de implementación. Sin consultor cobrando por hora. Solo la persona que construyó esto, sentada contigo mientras arrancas.'
              )}</p>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {SETUP.map((s) => (
                <div key={s.n} style={{ flex: '1 1 200px', borderTop: `2px solid ${s.last ? '#FAF9F6' : '#34343A'}`, paddingTop: 16 }}>
                  <div style={mono({ fontSize: 12, color: s.last ? '#FAF9F6' : '#A1A1A6' })}>{s.n}</div>
                  <div style={{ fontSize: 16.5, fontWeight: 600, marginTop: 10 }}>{s.t}</div>
                  <p style={{ fontSize: 13.5, lineHeight: 1.5, color: '#C9C9CE', margin: '6px 0 0' }}>{s.d}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ACT 3 */}
      <section id="trust" className="mk-sec mk-section mk-act-pad-top mk-act-pad-bottom" style={wrap({ padding: '96px 24px 32px' })}>
        <div style={{ borderTop: '1px solid #18181B', paddingTop: 36, display: 'flex', alignItems: 'baseline', gap: 28, flexWrap: 'wrap' }}>
          <span style={actNum}>03</span>
          <div>
            <div style={eyebrow}>{t('Can you trust us', '¿Puedes confiar en nosotros?')}</div>
            <h2 style={{ fontSize: 'clamp(26px,3.4vw,40px)', lineHeight: 1.05, letterSpacing: '-1.3px', fontWeight: 700, margin: '8px 0 0', maxWidth: 760 }}>{t('We can’t show you a wall of logos yet. So here’s what we’ll stand on instead.', 'Aún no tenemos una pared de logos. Así que aquí está lo que sí podemos respaldar.')}</h2>
          </div>
        </div>
      </section>

      {/* pilot */}
      <section className="mk-section" style={wrap({ padding: '56px 24px 0' })}>
        <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 320px' }}>
            <div style={eyebrow}>{t('Where Checked is today', 'Dónde está Checked hoy')}</div>
            <h3 style={{ fontSize: 'clamp(24px,3vw,34px)', lineHeight: 1.08, letterSpacing: '-1.1px', fontWeight: 700, margin: '14px 0 0' }}>{t(
              'No paying customers yet. Here’s the honest truth instead.',
              'Sin clientes pagando todavía. Aquí está la verdad, sin adornos.'
            )}</h3>
            <p style={{ fontSize: 16, lineHeight: 1.55, color: '#52525B', margin: '16px 0 0' }}>{t(
              'You can smell inflated numbers from across the dining room. So here’s exactly where things stand.',
              'Los números inflados se huelen desde la otra esquina del comedor. Así que esto es exactamente dónde estamos parados.'
            )}</p>
            <div style={{ marginTop: 22, background: '#18181B', color: '#FAF9F6', borderRadius: 14, padding: '20px 22px' }}>
              <div style={mono({ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#A1A1A6' })}>{t('By design, not policy', 'Por diseño, no por política')}</div>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8, lineHeight: 1.35 }}>{t(
                'We can’t touch your money, sell your data, or fudge your numbers — the system isn’t built to.',
                'No podemos tocar tu dinero, vender tu información, ni alterar tus números — el sistema no está hecho para eso.'
              )}</div>
            </div>
          </div>
          <div style={{ flex: '1 1 360px', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {PILOT.map((p) => (
              <div key={p.t} style={{ flex: '1 1 200px', ...card, borderRadius: 14, padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, background: '#EFEFEC', color: '#18181B', fontSize: 15 }}>✓</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginTop: 14 }}>{p.t}</div>
                <p style={{ fontSize: 13.5, lineHeight: 1.5, color: '#6B6B70', margin: '6px 0 0' }}>{p.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* testimonials */}
      <section className="mk-section" style={wrap({ padding: '80px 24px 0' })}>
        <div style={eyebrow}>{t('From the floor', 'Desde el piso')}</div>
        <h3 style={{ fontSize: 'clamp(24px,3vw,34px)', lineHeight: 1.08, letterSpacing: '-1.1px', fontWeight: 700, margin: '14px 0 0', maxWidth: 680 }}>{t(
          'Real words from real owners — coming soon.',
          'Palabras reales de dueños reales — muy pronto.'
        )}</h3>
        <p style={{ fontSize: 16, lineHeight: 1.55, color: '#52525B', margin: '14px 0 0', maxWidth: 600 }}>{t(
          'We’re in pilot, so we don’t have testimonials yet — and we’d rather leave this space honestly empty than fill it with words we made up. As our first partners come on, theirs go right here.',
          'Estamos en piloto, así que aún no tenemos testimonios — y preferimos dejar este espacio honestamente vacío que llenarlo con palabras inventadas. Conforme entren nuestros primeros socios, sus palabras van aquí.'
        )}</p>
        <div style={{ marginTop: 28, overflow: 'hidden', WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)', maskImage: 'linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)' }}>
          <div className="mk-marquee" style={{ display: 'flex', width: 'max-content', animation: 'testiScroll 48s linear infinite' }}>
            {[...TESTIMONIALS, ...TESTIMONIALS].map((row, i) => (
              <TestimonialCard key={i} q={row.q} who={row.who} city={row.city} />
            ))}
          </div>
        </div>
      </section>

      {/* principles */}
      <section className="mk-section" style={wrap({ padding: '72px 24px 0' })}>
        <div style={{ background: '#FFFFFF', border: '1px solid #E7E6E2', borderRadius: 18, padding: 'clamp(28px,4vw,44px)' }}>
          <div style={eyebrow}>{t('How we work', 'Cómo trabajamos')}</div>
          <h3 style={{ fontSize: 'clamp(22px,2.6vw,32px)', lineHeight: 1.08, letterSpacing: '-1px', fontWeight: 700, margin: '12px 0 0', maxWidth: 640 }}>{t('A few things we won’t trade away.', 'Algunas cosas que no vamos a negociar.')}</h3>
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column' }}>
            {PRINCIPLES.map((p) => (
              <div key={p.n} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 32px', alignItems: 'baseline', padding: '16px 0', borderTop: '1px solid #EAE8E2' }}>
                <div style={{ flex: '1 1 240px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={mono({ fontSize: 13, color: '#A1A1A6' })}>{p.n}</span>
                  <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>{p.t}</span>
                </div>
                <p style={{ flex: '2 1 360px', fontSize: 15, lineHeight: 1.5, color: '#52525B', margin: 0 }}>{p.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section id="book" className="mk-sec" style={{ background: '#18181B', color: '#FAF9F6', marginTop: 64 }}>
        <div className="mk-cta-section" style={wrap({ padding: '84px 24px' })}>
          <div className="mk-cta-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: 48, alignItems: 'center' }}>
            <div style={{ flex: '1 1 380px' }}>
              <h2 style={{ fontSize: 'clamp(32px,4.2vw,52px)', lineHeight: 1.0, letterSpacing: '-1.8px', fontWeight: 700, margin: 0 }}>{t('Let’s get your place ', 'Pongamos tu lugar en orden. Con ')}<span style={{ color: '#FFFFFF' }}>Checked</span>.</h2>
              <p style={{ fontSize: 18, lineHeight: 1.55, color: '#C9C9CE', margin: '20px 0 0', maxWidth: 440 }}>{t('Tell us a bit about your place and we’ll set up a quick walkthrough. We’ll figure out together if it’s the right fit.', 'Cuéntanos un poco de tu lugar y agendamos una llamada rápida. Decidimos juntos si es la solución para ti.')}</p>
              <div style={mono({ display: 'flex', flexWrap: 'nowrap', gap: '8px 18px', marginTop: 24, fontSize: 12.5, color: '#6B6B70', whiteSpace: 'nowrap' })}>
                <span>{t('Same day', 'El mismo día')}</span><span style={{ color: '#3A3A40' }}>·</span>
                <span>{t('Quick call', 'Llamada corta')}</span><span style={{ color: '#3A3A40' }}>·</span>
                <span>{t('No pressure', 'Sin presión')}</span>
              </div>
            </div>
            <DemoForm lang={lang} />
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="mk-footer" style={wrap({ padding: '34px 24px 48px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 18 })}>
        <BrandLockup size="sm" />
        <div style={mono({ fontSize: 12, color: '#A1A1A6' })}>{t('The daily operating system for independent restaurants.', 'El sistema operativo del día a día para restaurantes independientes.')}</div>
        <div style={mono({ fontSize: 12, color: '#A1A1A6' })}>© 2026 Checked</div>
      </footer>
      <LanguageToggle currentLang={lang} />
    </div>
  )
}
