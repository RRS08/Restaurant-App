// ----------------------------------------------------------------
// Buyer-facing pickup-ready email.
//
// Sent when a staff member advances a web pickup order from 'new'
// to 'ready' via the POS bubble or the /orders drawer. Fires
// through `after()` from the server action so the counter person's
// action stays instant regardless of Resend's response time.
//
// Copy is intentionally short — the buyer already got the full
// confirmation on checkout. This email is the "come pick it up"
// nudge, not a receipt. Same brand palette as
// order-email.ts so both messages read as one shop.
// ----------------------------------------------------------------

import { after } from 'next/server'
import { sendEmail, escapeHtml } from '@/lib/email/resend'
import { platformOriginForSlug, absoluteAssetUrl, checkedMarkUrl } from './hosts'
import type { SiteRow } from './types'

interface PickupReadyArgs {
  site: SiteRow
  orderId: string
  buyerEmail: string
  buyerName: string
  /** Optional pickup location line — e.g. "Mercado District · 123 Main
   *  St". Falls back to the site's shop name when omitted. */
  pickupLine: string | null
}

interface Palette {
  ink: string
  body: string
  line: string
  sand: string
  sage: string
  muted: string
  paper: string
  accent: string
}

const FALLBACK_PALETTE: Palette = {
  ink: '#18181B',
  body: '#52525B',
  line: '#E4E4E7',
  sand: '#F4F4F5',
  sage: '#E8F0E1',
  muted: '#71717A',
  paper: '#FFFFFF',
  accent: '#18181B',
}

const FONT_STACK = `'Outfit',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`

/** Queue the ready-for-pickup message. Non-blocking + idempotent —
 *  the Resend request keys on the order id so an accidental
 *  double-mark can't send two emails. */
export function queuePickupReadyEmail(args: PickupReadyArgs): void {
  after(async () => {
    try {
      const result = await sendPickupReadyEmail(args)
      if (result.status === 'sent') {
        console.log('[pickup-ready-email] sent', { orderId: args.orderId, resendId: result.id })
      } else if (result.status === 'skipped') {
        console.warn('[pickup-ready-email] skipped', { orderId: args.orderId, reason: result.reason })
      } else {
        console.error('[pickup-ready-email] failed', { orderId: args.orderId, error: result.error })
      }
    } catch (err) {
      console.error('[pickup-ready-email] threw', { orderId: args.orderId, err: String(err) })
    }
  })
}

async function sendPickupReadyEmail(args: PickupReadyArgs) {
  const siteName = args.site.name || 'Our shop'
  const orderNumber = args.orderId.slice(0, 8).toUpperCase()
  return sendEmail({
    to: args.buyerEmail,
    replyTo: merchantEmail(args.site),
    idempotencyKey: `pickup-ready:${args.orderId}`,
    subject: `Order ${orderNumber} is ready for pickup — ${siteName}`,
    text: buildText(args, orderNumber, siteName),
    html: buildHtml(args, orderNumber, siteName),
  })
}

function merchantEmail(site: SiteRow): string | null {
  const contact = (site.config?.contact ?? {}) as { email?: unknown }
  return typeof contact.email === 'string' && contact.email.includes('@') ? contact.email : null
}

function palette(site: SiteRow): Palette {
  const raw = (site.config?.theme_colors ?? {}) as Record<string, unknown>
  const pick = (k: keyof Palette): string =>
    typeof raw[k] === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw[k] as string)
      ? (raw[k] as string)
      : FALLBACK_PALETTE[k]
  return {
    ink: pick('ink'), body: pick('body'), line: pick('line'), sand: pick('sand'),
    sage: pick('sage'), muted: pick('muted'), paper: pick('paper'), accent: pick('accent'),
  }
}

function brandMark(site: SiteRow): { wordmark: string; kicker: string } {
  const config = (site.config ?? {}) as Record<string, unknown>
  const siteName = site.name ?? site.slug
  const idx = siteName.indexOf(' ')
  const wordmark = idx === -1 ? siteName : siteName.slice(0, idx)
  const kicker = typeof config.brand_kicker === 'string'
    ? config.brand_kicker
    : (idx === -1 ? '' : siteName.slice(idx + 1))
  return { wordmark, kicker }
}

function logoUrlFor(site: SiteRow, origin: string): string | null {
  const config = (site.config ?? {}) as Record<string, unknown>
  const raw = typeof config.logo_url === 'string' ? config.logo_url : '/assets/logo-tree.png'
  return absoluteAssetUrl(origin, raw)
}

function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? ''
}

function buildText(args: PickupReadyArgs, orderNumber: string, siteName: string): string {
  const first = firstNameOf(args.buyerName)
  const lines = [
    siteName,
    '',
    first ? `${first},` : 'Hi there,',
    `Your order is ready for pickup.`,
    '',
    `Order ${orderNumber}`,
  ]
  if (args.pickupLine) lines.push(args.pickupLine)
  lines.push('', 'Come by anytime during store hours. Thank you for letting us be part of your routine.')
  return lines.join('\n')
}

function buildHtml(args: PickupReadyArgs, orderNumber: string, siteName: string): string {
  const c = palette(args.site)
  const first = firstNameOf(args.buyerName)
  const origin = platformOriginForSlug(args.site.slug)
  const logoUrl = logoUrlFor(args.site, origin)
  const { wordmark, kicker } = brandMark(args.site)
  const markUrl = checkedMarkUrl()

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Order ${escapeHtml(orderNumber)} is ready</title>
</head>
<body style="margin:0;padding:0;background:${c.sage};font-family:${FONT_STACK};color:${c.ink};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.sage};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;background:${c.paper};border:1px solid ${c.line};border-radius:14px;overflow:hidden;">

        <!-- Header — site wordmark + kicker, logo on the left. -->
        <tr>
          <td style="padding:22px 28px 18px;border-bottom:1px solid ${c.line};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                ${logoUrl ? `<td valign="middle" width="44" style="width:44px;padding-right:12px;">
                  <img src="${escapeHtml(logoUrl)}" alt="" width="40" height="40" style="display:block;width:40px;height:40px;border:0;border-radius:8px;">
                </td>` : ''}
                <td valign="middle">
                  <div style="font-size:15px;font-weight:600;letter-spacing:-0.02em;color:${c.ink};line-height:1.1;">
                    ${escapeHtml(wordmark)}
                  </div>
                  ${kicker ? `<div style="font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:${c.muted};margin-top:3px;">
                    ${escapeHtml(kicker)}
                  </div>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body — one green-check icon, headline, order number, pickup line. -->
        <tr>
          <td align="center" style="padding:32px 28px 20px;">
            <div style="width:52px;height:52px;border-radius:50%;background:${c.sage};color:${c.ink};display:inline-block;line-height:52px;font-size:24px;font-weight:700;">✓</div>
            <h1 style="margin:16px 0 6px;font-size:22px;font-weight:700;letter-spacing:-0.03em;color:${c.ink};">
              ${first ? escapeHtml(first) + ', your order is ready.' : 'Your order is ready.'}
            </h1>
            <p style="margin:0;font-size:14px;line-height:1.55;color:${c.body};max-width:400px;">
              Come by anytime during store hours. Thank you for letting us be part of your routine.
            </p>
          </td>
        </tr>

        <!-- Order id + pickup line. -->
        <tr>
          <td style="padding:0 28px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${c.line};border-radius:10px;background:${c.sand};">
              <tr>
                <td style="padding:14px 16px;">
                  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${c.muted};margin-bottom:4px;">ORDER</div>
                  <div style="font-family:'Geist Mono',ui-monospace,monospace;font-size:14px;color:${c.ink};font-weight:600;letter-spacing:-0.01em;">
                    ${escapeHtml(orderNumber)}
                  </div>
                  ${args.pickupLine ? `<div style="margin-top:12px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${c.muted};margin-bottom:4px;">PICK UP AT</div>
                  <div style="font-size:14px;color:${c.ink};line-height:1.4;">${escapeHtml(args.pickupLine)}</div>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Sign-off. Checked mark sits below the shop's own footer
             just like the confirmation email — same signature, so
             every message from a Checked-hosted site carries the
             platform's mark as its final line. -->
        <tr>
          <td style="padding:0 28px 24px;">
            <hr style="border:0;border-top:1px solid ${c.line};margin:0 0 14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:12px;color:${c.muted};">
                  ${escapeHtml(siteName)}
                </td>
                <td align="right" valign="middle">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td valign="middle" style="padding-right:6px;">
                      <span style="font-size:10px;color:${c.muted};letter-spacing:0.02em;">Sent through</span>
                    </td>
                    <td valign="middle" style="padding-right:4px;">
                      <img src="${escapeHtml(markUrl)}" alt="" width="12" height="12" style="display:block;border:0;">
                    </td>
                    <td valign="middle">
                      <span style="font-size:12px;font-weight:600;letter-spacing:-0.005em;color:${c.ink};">checked</span>
                    </td>
                  </tr></table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}
