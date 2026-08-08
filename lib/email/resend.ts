// ----------------------------------------------------------------
// Resend transport — shared, zero-dependency.
//
// Same pattern the demo-lead notifier has used since day one: a
// plain fetch against Resend's REST API, no SDK. Lifted here so
// every transactional email in the app goes out one way instead of
// each caller hand-rolling its own fetch.
//
// Two rules this module enforces for its callers:
//
//   1. It never throws. Every failure comes back as a value. Email
//      is downstream of things that already happened (an order was
//      placed, a card was charged) — a Resend outage must never
//      turn into a user-visible failure of the thing that worked.
//
//   2. It no-ops when unconfigured. Missing RESEND_API_KEY or no
//      sender = { status: 'skipped' }, not an error. That keeps
//      code shippable ahead of the env vars and keeps preview
//      deploys from mailing real people.
//
// Env:
//   RESEND_API_KEY     → Resend dashboard → API Keys
//   TRANSACTIONAL_FROM → customer-facing no-reply sender, e.g.
//                        orders@onchecked.app. Preferred.
//   MARKETING_FROM     → the existing lead/marketing sender. Used
//                        only as a fallback so order mail still
//                        goes out before TRANSACTIONAL_FROM is set
//                        in Vercel.
// Whichever sender is used must be on a Resend-verified domain.
// ----------------------------------------------------------------

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export interface SendEmailArgs {
  to: string
  subject: string
  html: string
  text: string
  /** Where a buyer's reply should land — normally the merchant, not
   *  us. Omitted = replies bounce off the no-reply sender. */
  replyTo?: string | null
  /** Resend dedupes POSTs that share this key for 24h, so a retried
   *  or replayed request sends exactly one message. Callers should
   *  key it on the thing being notified about (an order id), never
   *  on a timestamp or random value. */
  idempotencyKey?: string
  /** Override the resolved sender. Rarely needed. */
  from?: string
}

export type SendEmailResult =
  | { status: 'sent'; id: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

/** Customer-facing sender, preferring the transactional address over
 *  the marketing one. Null when neither is configured. */
export function transactionalFrom(): string | null {
  return process.env.TRANSACTIONAL_FROM || process.env.MARKETING_FROM || null
}

export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const key = process.env.RESEND_API_KEY
  const from = args.from || transactionalFrom()
  if (!key) return { status: 'skipped', reason: 'RESEND_API_KEY not set' }
  if (!from) return { status: 'skipped', reason: 'no sender configured (TRANSACTIONAL_FROM / MARKETING_FROM)' }
  if (!args.to) return { status: 'skipped', reason: 'no recipient address' }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
        ...(args.idempotencyKey ? { 'idempotency-key': args.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject,
        text: args.text,
        html: args.html,
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
      }),
    })
    const raw = await res.text().catch(() => '')
    if (!res.ok) {
      return { status: 'failed', error: `Resend ${res.status}: ${raw.slice(0, 300)}` }
    }
    let id: string | null = null
    try { id = (JSON.parse(raw) as { id?: string }).id ?? null } catch { /* body shape is not load-bearing */ }
    return { status: 'sent', id }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Entity-escape for interpolating buyer-supplied text into the HTML
 *  body. Covers the four characters that can break markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
