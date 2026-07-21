'use server'

// ----------------------------------------------------------------
// Demo lead capture — server actions
//
// The "Book a demo" form on the marketing page submits here.
// Three filters before the lead lands in the demo_leads table:
//
//   1. Honeypot — a hidden `website` field that real users never
//      fill in. Bots, which blindly fill every input they see,
//      will trip it. Honeypot-trip rows still get logged with
//      rejected=true + rejection_reason='honeypot' so we can see
//      scale-of-attack, but the form pretends to succeed so the
//      bot doesn't realize it was caught.
//
//   2. IP rate limit — max 5 submissions per IP per hour. Real
//      users almost never submit twice; this catches scripted
//      enumeration without affecting any legitimate flow.
//
//   3. Email shape — RFC-ish regex. Cheap.
//
// Going forward we can also add Cloudflare Turnstile by setting
// TURNSTILE_SECRET_KEY in env vars; the action checks for it and
// silently skips when not configured.
// ----------------------------------------------------------------

import { headers } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isDevEmail } from '@/lib/dev'

const RATE_LIMIT_PER_IP_PER_HOUR = 5

// Resolves the requester's IP from the standard proxy headers Vercel
// + Cloudflare set. Falls back to 'unknown' so the rate-limit query
// still groups rows even when the header is missing.
async function resolveIp(): Promise<string> {
  const h = await headers()
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip')?.trim() ??
    'unknown'
  )
}

async function resolveUserAgent(): Promise<string | null> {
  const h = await headers()
  return h.get('user-agent') ?? null
}

// Cloudflare Turnstile verification. No-op when keys aren't set —
// honeypot + rate limit still protect us; Turnstile is the "we got
// hit hard, let's add a captcha" upgrade. Implemented inline so we
// don't pull in a captcha library before the user wires Cloudflare.
async function verifyTurnstile(token: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return true   // not configured → pass
  if (!token) return false
  try {
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }),
      },
    )
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    // If Cloudflare is unreachable, fail closed — we'd rather drop
    // a legitimate submission than open the gate during an outage.
    return false
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ----------------------------------------------------------------
// notifyDemoLead — fire-and-forget email to the owner inbox when a
// legitimate demo lead lands. Resend REST API, no SDK (same
// zero-dep pattern as verifyTurnstile above).
//
// Gated on env vars — when any of the three below is missing, the
// call is a no-op and the form still returns success. That means:
//   • the code can ship before Resend is set up (staged rollout)
//   • an outage or key rotation never blocks a form submission
//   • the demo_leads table is always the source of truth; email is
//     just a nudge so the owner doesn't have to poll /dev-tools
//
// Required env in Vercel once Resend is live:
//   RESEND_API_KEY   → Resend dashboard → API Keys → create
//   NOTIFY_EMAIL     → renato@onchecked.app (or wherever)
//   MARKETING_FROM   → e.g. leads@onchecked.app — must be a sender
//                      on a Resend-verified domain
// ----------------------------------------------------------------
async function notifyDemoLead(input: {
  email: string
  concept: string | null
  message: string | null
  ip: string
  userAgent: string | null
}): Promise<void> {
  const key = process.env.RESEND_API_KEY
  const to = process.env.NOTIFY_EMAIL
  const from = process.env.MARKETING_FROM
  if (!key || !to || !from) return

  const subject = `New demo lead — ${input.email}`
  const rows: [string, string][] = [
    ['Email',   input.email],
    ['Concept', input.concept ?? '—'],
    ['Message', input.message ?? '—'],
    ['IP',      input.ip],
    ['Agent',   (input.userAgent ?? '—').slice(0, 200)],
    ['When',    new Date().toISOString()],
  ]

  // Plain-text body first (some inboxes prefer it), HTML as the
  // richer alternative — Resend uses HTML when both are provided.
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
  const html = `
<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.6;color:#18181B;">
  <p style="margin:0 0 12px;font-weight:600;">New demo lead landed.</p>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    ${rows.map(([k, v]) => `
      <tr>
        <td style="padding:2px 12px 2px 0;color:#6B6B70;vertical-align:top;">${k}</td>
        <td style="padding:2px 0;color:#18181B;">${escapeHtml(v)}</td>
      </tr>
    `).join('')}
  </table>
</div>
  `.trim()

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        // Set reply-to so hitting Reply in the inbox goes straight to
        // the prospect instead of the noreply sender.
        reply_to: input.email,
        subject,
        text,
        html,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[demo-leads] Resend send failed', res.status, body)
    }
  } catch (err) {
    // Never let email failure surface to the submitter — the DB
    // write already succeeded and that's what matters.
    console.error('[demo-leads] Resend send threw', err)
  }
}

// Minimal HTML entity escape for the notification body — covers
// the four characters that can break the table layout or turn a
// stray "<script" from a bot payload into markup.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ----------------------------------------------------------------
// submitDemoLead — the public-facing call.
// Returns useActionState-friendly { error?, ok? } from the form.
// ----------------------------------------------------------------
export async function submitDemoLead(
  prevState: { error?: string; ok?: boolean } | null,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const email = ((formData.get('email') as string | null) ?? '').trim()
  const concept = ((formData.get('concept') as string | null) ?? '').trim() || null
  const message = ((formData.get('message') as string | null) ?? '').trim() || null
  // Honeypot. Real form has no visible field by this name; bots
  // that auto-fill every input will populate it.
  const honeypot = ((formData.get('website') as string | null) ?? '').trim()
  const turnstileToken = (formData.get('cf-turnstile-response') as string | null) ?? null

  const ip = await resolveIp()
  const userAgent = await resolveUserAgent()
  const admin = createAdminClient()

  // Honeypot trip — log the rejection but mirror the success
  // shape so the bot operator doesn't learn we filtered it.
  if (honeypot.length > 0) {
    await admin.from('demo_leads').insert({
      email: email || '(empty)',
      concept,
      message,
      ip_address: ip,
      user_agent: userAgent,
      rejected: true,
      rejection_reason: 'honeypot',
    })
    return { ok: true }
  }

  if (!email) return { error: 'Enter your email so we can reach you.' }
  if (!EMAIL_RE.test(email)) return { error: 'That email doesn’t look right.' }

  // IP rate limit. 5 leads per hour per IP — well above any
  // legitimate single-prospect flow, low enough to choke a script.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCount } = await admin
    .from('demo_leads')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .gte('created_at', oneHourAgo)

  if ((recentCount ?? 0) >= RATE_LIMIT_PER_IP_PER_HOUR) {
    await admin.from('demo_leads').insert({
      email,
      concept,
      message,
      ip_address: ip,
      user_agent: userAgent,
      rejected: true,
      rejection_reason: 'rate_limit',
    })
    return { error: 'Too many submissions from this network. Try again in an hour.' }
  }

  // Turnstile (only enforced when TURNSTILE_SECRET_KEY is set).
  const turnstileOk = await verifyTurnstile(turnstileToken)
  if (!turnstileOk) {
    await admin.from('demo_leads').insert({
      email,
      concept,
      message,
      ip_address: ip,
      user_agent: userAgent,
      rejected: true,
      rejection_reason: 'turnstile',
    })
    return { error: 'Bot check failed. Refresh and try again.' }
  }

  // Lead is good. Land it.
  const { error: insertErr } = await admin.from('demo_leads').insert({
    email,
    concept,
    message,
    ip_address: ip,
    user_agent: userAgent,
    rejected: false,
  })
  if (insertErr) {
    return { error: 'Could not save your request right now. Try again.' }
  }

  // Fire-and-forget owner notification. `await` because we're in a
  // server action (no background task infrastructure to detach to),
  // but the function swallows its own errors — a Resend outage
  // never blocks the form's success response.
  await notifyDemoLead({ email, concept, message, ip, userAgent })

  return { ok: true }
}

// ----------------------------------------------------------------
// listDemoLeads — dev-only. Used by the /dev-tools card so you
// can see who's reached out without leaving the app.
// ----------------------------------------------------------------
export interface DemoLeadRow {
  id: string
  email: string
  concept: string | null
  message: string | null
  ipAddress: string | null
  userAgent: string | null
  rejected: boolean
  rejectionReason: string | null
  createdAt: string
}

export async function listDemoLeads(): Promise<{ leads: DemoLeadRow[]; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { leads: [], error: 'Not signed in.' }
  if (!isDevEmail(user.email)) return { leads: [], error: 'Dev only.' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('demo_leads')
    .select('id, email, concept, message, ip_address, user_agent, rejected, rejection_reason, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return { leads: [], error: error.message }
  const leads: DemoLeadRow[] = (data ?? []).map((r) => ({
    id: r.id as string,
    email: r.email as string,
    concept: (r.concept as string | null) ?? null,
    message: (r.message as string | null) ?? null,
    ipAddress: (r.ip_address as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
    rejected: r.rejected as boolean,
    rejectionReason: (r.rejection_reason as string | null) ?? null,
    createdAt: r.created_at as string,
  }))
  return { leads }
}
