// ----------------------------------------------------------------
// ComingSoon — shared empty-state used by the online-workspace
// page stubs (/chat, /orders, /catalog, /customers, /edit-site).
//
// One component so all five pages read as one system while the
// real UIs land. Centered card, small eyebrow, calm body, and a
// muted "Coming soon" pill so the operator knows this is a
// placeholder — not a broken page. No CTA; no fake features.
// ----------------------------------------------------------------

const INK = '#18181B'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const LINE = '#E7E6E2'
const SURFACE = '#FAFAF9'

export default function ComingSoon({
  eyebrow, title, body,
}: {
  eyebrow: string
  title: string
  body: string
}) {
  return (
    <div
      style={{
        minHeight: 'calc(100vh - 40px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
        fontFamily: "'Geist', system-ui, sans-serif", color: INK,
      }}
    >
      <div
        style={{
          maxWidth: 440, textAlign: 'center',
          border: `1px solid ${LINE}`, borderRadius: 14, background: '#fff',
          padding: '32px 28px',
        }}
      >
        <div style={{
          fontFamily: "'Geist Mono', ui-monospace, monospace",
          fontSize: 10, letterSpacing: '0.16em', color: FAINT, marginBottom: 12,
        }}>
          {eyebrow}
        </div>
        <h1 style={{
          margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em',
          color: INK,
        }}>
          {title}
        </h1>
        <p style={{
          margin: '10px auto 20px', maxWidth: 380,
          fontSize: 13.5, lineHeight: 1.55, color: MUTED,
        }}>
          {body}
        </p>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          borderRadius: 999, padding: '4px 11px',
          fontSize: 11, fontWeight: 600,
          background: SURFACE, color: MUTED, border: `1px solid ${LINE}`,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#C4C4C7' }} />
          Coming soon
        </span>
      </div>
    </div>
  )
}
