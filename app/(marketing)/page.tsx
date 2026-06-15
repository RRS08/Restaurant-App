// ----------------------------------------------------------------
// Marketing landing page — checked.app/
//
// Server component. Renders the marketing site and mounts two client
// islands: <FloorSim /> (interactive demo) and <DemoForm /> (CTA).
// Logo uses the shared brand components. Sign-up links are same-origin
// (/signup) since the app lives in this same Next project.
//
// Type texture: Geist Sans (inherited from app/layout body) + Geist
// Mono via the MONO var for the "ledger" eyebrows and figures.
// ----------------------------------------------------------------

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { BrandLockup } from '@/components/brand'
import FloorSim from '@/components/marketing/floor-sim'
import DemoForm from '@/components/marketing/demo-form'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })

const wrap = (extra: CSSProperties = {}): CSSProperties => ({ maxWidth: 1160, margin: '0 auto', ...extra })
const eyebrow: CSSProperties = { ...mono(), fontSize: 11.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6B6B70' }
const actNum: CSSProperties = { ...mono(), fontSize: 40, fontWeight: 600, lineHeight: 1, color: '#18181B' }
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

const PROBLEMS = [
  { n: '01', t: 'A POS', d: 'Takes the money. Knows nothing about stock.', dark: false },
  { n: '02', t: 'A spreadsheet', d: 'For stock. Last updated… you’re not sure.', dark: false },
  { n: '03', t: 'A notebook', d: 'The schedule, in your handwriting.', dark: false },
  { n: '04', t: 'The bank app', d: 'For money. Two days behind reality.', dark: false },
  { n: '05', t: 'Your head', d: 'Everything else. Until 11pm.', dark: true },
]

const PILOT = [
  { t: 'Built end-to-end & deployed', d: 'POS, inventory, staffing, finance, analytics — all working. Not mockups.' },
  { t: 'Your money, handled safely', d: 'Bank connection and card payments are real, secure, and tested — not "coming soon."' },
  { t: 'Field-testing in progress', d: 'Sitting down with independent restaurants across the USA now.' },
  { t: '8 restaurant archetypes', d: 'Taqueria, mariscos, bakery, BBQ, cafe & more — your concept, your ingredients.' },
]

const SETUP = [
  { n: '01', t: 'Grab your iPad', d: 'The one already sitting on the counter. No new device to buy.', last: false },
  { n: '02', t: 'Plug in drawer & printer', d: 'Your cash drawer and ticket printer — standard hardware, no special kit.', last: false },
  { n: '03', t: 'Pick your preset', d: 'Your concept, your menu, your ingredients — loaded and ready to tweak.', last: false },
  { n: '04', t: 'You’re live', d: 'Ringing real tickets — and reconciling real money — the same afternoon.', last: true },
]

const PRINCIPLES = [
  { n: '01', t: 'Value first.', d: 'The product has to earn its keep before it asks for a dollar. Revenue is what happens when a real problem gets solved well — not the other way around.' },
  { n: '02', t: 'Radical transparency.', d: 'Honest terms, and what it can’t do yet — said out loud. If you ever want to leave, it’s one click, not a phone tree.' },
  { n: '03', t: 'You’re a partner, not a ticket.', d: 'Your wins are my wins. However big this gets, you stay heard, supported, and one message away from the person who built it.' },
  { n: '04', t: 'Never a forced sale.', d: 'If Checked isn’t right for your place, I’ll tell you. We only work together when there’s a real fit — that’s how this lasts.' },
]

const TESTIMONIALS = [
  { q: 'A pilot partner’s words go here — what changed once every number finally agreed.', who: '[Owner] · [Taqueria]', city: '[City]' },
  { q: 'A pilot partner’s words go here — the Sunday night they stopped reconstructing the week by hand.', who: '[Owner] · [Mariscos]', city: '[City]' },
  { q: 'A pilot partner’s words go here — the first lunch rush they didn’t run out of anything.', who: '[Owner] · [Bakery]', city: '[City]' },
  { q: 'A pilot partner’s words go here — live the same afternoon, on the iPad they already had.', who: '[Owner] · [BBQ]', city: '[City]' },
  { q: 'A pilot partner’s words go here — finally seeing the real margin, in real time.', who: '[Owner] · [Cafe]', city: '[City]' },
]

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

export default function MarketingPage() {
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
      `}</style>

      {/* NAV */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 50, backdropFilter: 'saturate(1.4) blur(10px)', background: 'rgba(250,249,246,0.82)', borderBottom: '1px solid #E7E6E2' }}>
        <div style={wrap({ padding: '13px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' })}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}><BrandLockup size="md" /></Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
            <a href="#what" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>The Platform</a>
            <a href="#why" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>The Difference</a>
            <a href="#trust" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>Our Commitment</a>
            <a href="#book" style={{ fontSize: 14, color: '#52525B', textDecoration: 'none' }}>Book a demo</a>
            <Link href="/signup" style={{ background: '#18181B', color: '#FAF9F6', textDecoration: 'none', fontSize: 14, fontWeight: 600, padding: '9px 17px', borderRadius: 9 }}>Sign up</Link>
          </div>
        </div>
      </nav>

      {/* HERO — fills the viewport below the nav so Act 1 sits
          deliberately below the fold. The user has to scroll to
          reach the first section, which gives the entrance
          animation room to land and naturally separates the
          marketing tagline from the rest of the page. */}
      <section style={wrap({ padding: '40px 24px', minHeight: 'calc(100vh - 60px)', display: 'flex', alignItems: 'center' })}>
        <div style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 48, alignItems: 'center' }}>
          <div style={{ flex: '1 1 440px' }}>
            <div style={{ ...eyebrow, ...enter(0) }}>Daily operating system · Hecho para due&ntilde;os</div>
            <h1 style={{ fontSize: 'clamp(38px,5.4vw,66px)', lineHeight: 0.98, letterSpacing: '-2.2px', fontWeight: 700, margin: '22px 0 0', ...enter(120) }}>Run the whole place from the counter you&apos;re already standing at.</h1>
            <p style={{ fontSize: 19, lineHeight: 1.55, color: '#52525B', maxWidth: 500, margin: '24px 0 0', ...enter(260) }}>One ring moves your stock, your menu, your cash, and your books. So &ldquo;what happened today&rdquo; stops being a Sunday-night guess with a calculator and a shoebox of receipts.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 30, ...enter(400) }}>
              <Link href="/signup" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: '#18181B', color: '#FAF9F6', textDecoration: 'none', fontSize: 16, fontWeight: 600, padding: '15px 26px', borderRadius: 11 }}>Get started <span style={mono()}>&rarr;</span></Link>
              <a href="#book" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: 'transparent', color: '#18181B', textDecoration: 'none', fontSize: 16, fontWeight: 600, padding: '15px 22px', borderRadius: 11, border: '1px solid #D8D8D4' }}>Book a demo</a>
            </div>
            <div style={mono({ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 26, fontSize: 12.5, color: '#6B6B70', ...enter(540) })}>
              <span>Owner-operator first</span><span style={{ color: '#D0D0CC' }}>·</span>
              <span>Live the same afternoon</span><span style={{ color: '#D0D0CC' }}>·</span>
              <span>No CSV import</span>
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
          <div style={{ flex: '0 1 300px', minWidth: 260, margin: '0 auto', ...enter(280) }}>
            <div style={mono({ background: '#FFFFFF', border: '1px solid #E7E6E2', borderRadius: '14px 14px 0 0', boxShadow: '0 28px 60px -32px rgba(24,24,27,0.30)', padding: 22, color: '#18181B' })}>
              <div style={{ textAlign: 'center', borderBottom: '1px dashed #D8D8D4', paddingBottom: 14, ...typeIn(1100, 800) }}>
                <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: 1 }}>TACOS DON PORK</div>
                <div style={{ fontSize: 10.5, color: '#A1A1A6', marginTop: 3 }}>Mar 14 · 1:24 PM · Counter 1</div>
              </div>
              <div style={{ fontSize: 12.5, padding: '14px 0', display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(1990, 500) }}><span>2× Tacos al Pastor</span><span>7.00</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(2590, 500) }}><span>1× Quesabirria</span><span>4.75</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', ...typeIn(3190, 500) }}><span>1× Horchata</span><span>3.50</span></div>
              </div>
              <div style={{ borderTop: '1px dashed #D8D8D4', padding: '13px 0 0', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B6B70', ...typeIn(3790, 550) }}><span>Stock updated</span><span style={{ color: '#18181B' }}>−3 ingredients</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600, ...typeIn(4440, 500) }}><span>TOTAL</span><span>$15.25</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, paddingTop: 12, borderTop: '1px dashed #D8D8D4', ...typeIn(5040, 700) }}>
                  <span style={{ color: '#6B6B70' }}>Next morning</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>reconciled <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: '#18181B', color: '#FFF', fontSize: 10, ...popIn(5840) }}>✓</span></span>
                </div>
              </div>
            </div>
            <div style={{ height: 11, background: '#FFFFFF', clipPath: 'polygon(0 0,8.33% 100%,16.66% 0,25% 100%,33.33% 0,41.66% 100%,50% 0,58.33% 100%,66.66% 0,75% 100%,83.33% 0,91.66% 100%,100% 0)' }} />
          </div>
        </div>
      </section>

      {/* ACT 1 */}
      <section id="what" className="mk-sec" style={wrap({ padding: '40px 24px 8px' })}>
        <div style={{ borderTop: '1px solid #18181B', paddingTop: 24, display: 'flex', alignItems: 'baseline', gap: 20, flexWrap: 'wrap' }}>
          <span style={actNum}>01</span>
          <div>
            <div style={eyebrow}>What it is &amp; what it fixes</div>
            <h2 style={{ fontSize: 'clamp(26px,3.4vw,40px)', lineHeight: 1.05, letterSpacing: '-1.3px', fontWeight: 700, margin: '8px 0 0', maxWidth: 760 }}>Your tools don&apos;t talk to each other. Checked makes them one screen.</h2>
          </div>
        </div>
      </section>

      {/* problem */}
      <section style={wrap({ padding: '36px 24px 8px' })}>
        <p style={{ fontSize: 17, lineHeight: 1.55, color: '#52525B', margin: '0 0 26px', maxWidth: 620 }}>Two things quietly bleed an independent restaurant. First, stock you track by hand — until you run out of pastor in the middle of the rush and start turning tables away. Second, money that never quite squares: credits, invoices, delayed payouts, payroll you estimated but never checked against what actually went out. Every tool you buy to fix it speaks its own language, so the real numbers end up stitched together by hand in a spreadsheet. That&apos;s the mess Checked replaces.</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {PROBLEMS.map((p) => (
            <div key={p.n} style={{ flex: '1 1 160px', background: p.dark ? '#18181B' : '#FFFFFF', color: p.dark ? '#FAF9F6' : undefined, border: p.dark ? 'none' : '1px solid #E7E6E2', borderRadius: 13, padding: 18 }}>
              <div style={mono({ fontSize: 11, color: p.dark ? '#6B6B70' : '#A1A1A6' })}>{p.n}</div>
              <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 8 }}>{p.t}</div>
              <div style={{ fontSize: 13, color: p.dark ? '#C9C9CE' : '#6B6B70', marginTop: 4, lineHeight: 1.45 }}>{p.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* live demo */}
      <section style={wrap({ padding: '44px 24px 64px' })}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
          <h3 style={{ fontSize: 'clamp(22px,2.8vw,32px)', lineHeight: 1.08, letterSpacing: '-1px', fontWeight: 700, margin: 0, maxWidth: 620 }}>Checked replaces all five with one. Ring up an order and watch the rest catch up — instantly.</h3>
          <p style={mono({ fontSize: 12.5, color: '#6B6B70', maxWidth: 240, lineHeight: 1.6 })}>This is the actual product, running right here. Tap a dish.</p>
        </div>
        <FloorSim />
      </section>

      {/* ACT 2 */}
      <section id="why" className="mk-sec" style={{ background: '#F0F0EC' }}>
        <div style={wrap({ padding: '64px 24px 8px' })}>
          <div style={{ borderTop: '1px solid #18181B', paddingTop: 24, display: 'flex', alignItems: 'baseline', gap: 20, flexWrap: 'wrap' }}>
            <span style={actNum}>02</span>
            <div>
              <div style={eyebrow}>Why get it from us</div>
              <h2 style={{ fontSize: 'clamp(26px,3.4vw,40px)', lineHeight: 1.05, letterSpacing: '-1.3px', fontWeight: 700, margin: '8px 0 0', maxWidth: 760 }}>Built around the person running the floor — whether that&apos;s one counter or fifty.</h2>
            </div>
          </div>
        </div>

        <div style={wrap({ padding: '34px 24px 0' })}>
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
              { t: 'One package.', d: 'Everything your floor needs — POS, inventory, staffing, finance, analytics — on one screen and one bill. Not a base product with the essentials sold back to you as add-ons.', bottom: false },
              { t: 'One afternoon.', d: 'No six-week rollout, no implementation fee, no data migration. You’re up and ringing real tickets the same day you decide — the steps below take one afternoon.', bottom: false },
              { t: 'One person.', d: 'You reach a human who obsesses over your service — not a ticket queue. We grow only as fast as we can keep treating you like a partner.', bottom: true },
            ].map((row) => (
              <div key={row.t} style={{ display: 'flex', gap: 'clamp(16px,4vw,44px)', flexWrap: 'wrap', alignItems: 'baseline', borderTop: '1px solid #E2E0DA', borderBottom: row.bottom ? '1px solid #E2E0DA' : undefined, padding: '24px 0' }}>
                <div style={{ flex: '0 0 auto', minWidth: 230, fontSize: 'clamp(34px,5vw,56px)', fontWeight: 700, letterSpacing: '-2.2px', lineHeight: 0.92 }}>{row.t}</div>
                <p style={{ flex: '1 1 320px', fontSize: 17, lineHeight: 1.5, color: '#52525B', margin: 0 }}>{row.d}</p>
              </div>
            ))}
          </div>
        </div>

        {/* setup speed */}
        <div style={wrap({ padding: '48px 24px 64px' })}>
          <div style={{ background: '#18181B', color: '#FAF9F6', borderRadius: 18, padding: 'clamp(28px,4vw,44px)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 32px', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 32 }}>
              <div>
                <div style={mono({ fontSize: 11.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#A1A1A6' })}>Live by lunch, not next quarter</div>
                <h3 style={{ fontSize: 'clamp(24px,3.2vw,38px)', lineHeight: 1.05, letterSpacing: '-1.2px', fontWeight: 700, margin: '14px 0 0', maxWidth: 620 }}>Most systems take weeks and a consultant. Checked takes an afternoon.</h3>
              </div>
              <p style={{ fontSize: 15, lineHeight: 1.55, color: '#C9C9CE', maxWidth: 300, margin: 0 }}>No 90-day rollout. No implementation fee. No data migration project. Just the hardware that&apos;s already on your counter.</p>
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
      <section id="trust" className="mk-sec" style={wrap({ padding: '64px 24px 8px' })}>
        <div style={{ borderTop: '1px solid #18181B', paddingTop: 24, display: 'flex', alignItems: 'baseline', gap: 20, flexWrap: 'wrap' }}>
          <span style={actNum}>03</span>
          <div>
            <div style={eyebrow}>Can you trust us</div>
            <h2 style={{ fontSize: 'clamp(26px,3.4vw,40px)', lineHeight: 1.05, letterSpacing: '-1.3px', fontWeight: 700, margin: '8px 0 0', maxWidth: 760 }}>We can&apos;t show you a wall of logos yet. So here&apos;s what we&apos;ll stand on instead.</h2>
          </div>
        </div>
      </section>

      {/* pilot */}
      <section style={wrap({ padding: '40px 24px 0' })}>
        <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 320px' }}>
            <div style={eyebrow}>Where Checked is today</div>
            <h3 style={{ fontSize: 'clamp(24px,3vw,34px)', lineHeight: 1.08, letterSpacing: '-1.1px', fontWeight: 700, margin: '14px 0 0' }}>No paying customers yet. Here&apos;s the honest truth instead.</h3>
            <p style={{ fontSize: 16, lineHeight: 1.55, color: '#52525B', margin: '16px 0 0' }}>You can smell inflated numbers from across the dining room. So here&apos;s exactly where things stand.</p>
            <div style={{ marginTop: 22, background: '#18181B', color: '#FAF9F6', borderRadius: 14, padding: '20px 22px' }}>
              <div style={mono({ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#A1A1A6' })}>Looking for</div>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8, lineHeight: 1.35 }}>3–5 owner-operators to build this with — before we open it up.</div>
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
      <section style={wrap({ padding: '56px 24px 0' })}>
        <div style={eyebrow}>From the floor</div>
        <h3 style={{ fontSize: 'clamp(24px,3vw,34px)', lineHeight: 1.08, letterSpacing: '-1.1px', fontWeight: 700, margin: '14px 0 0', maxWidth: 680 }}>Real words from real owners — coming soon.</h3>
        <p style={{ fontSize: 16, lineHeight: 1.55, color: '#52525B', margin: '14px 0 0', maxWidth: 600 }}>We&apos;re in pilot, so we don&apos;t have testimonials yet — and we&apos;d rather leave this space honestly empty than fill it with words we made up. As our first partners come on, theirs go right here.</p>
        <div style={{ marginTop: 28, overflow: 'hidden', WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)', maskImage: 'linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)' }}>
          <div className="mk-marquee" style={{ display: 'flex', width: 'max-content', animation: 'testiScroll 48s linear infinite' }}>
            {[...TESTIMONIALS, ...TESTIMONIALS].map((t, i) => (
              <TestimonialCard key={i} q={t.q} who={t.who} city={t.city} />
            ))}
          </div>
        </div>
      </section>

      {/* principles */}
      <section style={wrap({ padding: '48px 24px 0' })}>
        <div style={{ background: '#FFFFFF', border: '1px solid #E7E6E2', borderRadius: 18, padding: 'clamp(28px,4vw,44px)' }}>
          <div style={eyebrow}>How we work · C&oacute;mo trabajamos</div>
          <h3 style={{ fontSize: 'clamp(22px,2.6vw,32px)', lineHeight: 1.08, letterSpacing: '-1px', fontWeight: 700, margin: '12px 0 0', maxWidth: 640 }}>A few things we won&apos;t trade away.</h3>
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
        <div style={wrap({ padding: '84px 24px' })}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 48, alignItems: 'center' }}>
            <div style={{ flex: '1 1 380px' }}>
              <h2 style={{ fontSize: 'clamp(32px,4.2vw,52px)', lineHeight: 1.0, letterSpacing: '-1.8px', fontWeight: 700, margin: 0 }}>Let&apos;s get your place <span style={{ color: '#FFFFFF' }}>Checked</span>.</h2>
              <p style={{ fontSize: 18, lineHeight: 1.55, color: '#C9C9CE', margin: '20px 0 0', maxWidth: 440 }}>Book a 20-minute demo. I&apos;ll switch the preset to match your concept and you&apos;ll watch your own ingredients move from a real ring.</p>
              <div style={mono({ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 24, fontSize: 12.5, color: '#6B6B70' })}>
                <span>No CSV import</span><span style={{ color: '#3A3A40' }}>·</span>
                <span>No 90-day setup</span><span style={{ color: '#3A3A40' }}>·</span>
                <span>Live the same afternoon</span>
              </div>
            </div>
            <DemoForm />
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={wrap({ padding: '34px 24px 48px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 18 })}>
        <BrandLockup size="sm" />
        <div style={mono({ fontSize: 12, color: '#A1A1A6' })}>The daily operating system for independent restaurants.</div>
        <div style={mono({ fontSize: 12, color: '#A1A1A6' })}>© 2026 Checked</div>
      </footer>
    </div>
  )
}
