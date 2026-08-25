// ----------------------------------------------------------------
// Merchant-facing "new online order" ping.
//
// Fires alongside the buyer's confirmation email whenever a paid
// web order lands. Lands in the shop's own inbox
// (site.config.contact.email) so the owner gets an immediate
// notification — Outlook / Gmail mobile push functions as a
// stand-in for a real SMS at zero marginal cost.
//
// Ops-flavor, not customer-facing:
//   - Subject leads with "New order" + total so the notification
//     preview on a phone lock screen carries the whole story.
//   - Body is a compact summary (customer, channel, items, total)
//     + a link back into Checked's /orders for one-tap follow-up.
//   - No brand palette dance — the merchant already knows their
//     own shop; the email reads as a system notification, not
//     a promo. Sign-off is the Checked mark so the merchant knows
//     which product it came from.
//
// Skipped silently when the site hasn't configured a contact
// email — dispatching to a null address would 400 loudly for no
// gain. Idempotent on the order id so a replayed checkout can't
// send two pings.
// ----------------------------------------------------------------

import { after } from 'next/server'
import { sendEmail, escapeHtml } from '@/lib/email/resend'
import { checkedMarkUrl } from './hosts'
import type { SiteRow } from './types'
import type { CartSnapshot } from './cart'

export interface MerchantNewOrderArgs {
  site: SiteRow
  orderId: string
  buyerName: string
  buyerEmail: string
  buyerPhone: string | null
  cart: CartSnapshot
  total: number
  channelLabel: string
  shippingLine: string | null
  pickupLabel: string | null
}

/** Queue the merchant ping to fire after the response is flushed.
 *  Non-blocking + swallows failures — buyer's checkout success
 *  page never waits on the merchant's notification. */
export function queueMerchantNewOrderEmail(args: MerchantNewOrderArgs): void {
  after(async () => {
    try {
      const result = await sendMerchantNewOrder(args)
      if (result.status === 'sent') {
        console.log('[merchant-new-order-email] sent', { orderId: args.orderId, resendId: result.id })
      } else if (result.status === 'skipped') {
        console.log('[merchant-new-order-email] skipped', { orderId: args.orderId, reason: result.reason })
      } else {
        console.error('[merchant-new-order-email] failed', { orderId: args.orderId, error: result.error })
      }
    } catch (err) {
      console.error('[merchant-new-order-email] threw', { orderId: args.orderId, err: String(err) })
    }
  })
}

async function sendMerchantNewOrder(args: MerchantNewOrderArgs) {
  const merchant = merchantEmail(args.site)
  if (!merchant) {
    return { status: 'skipped' as const, reason: 'no contact email on site.config' }
  }
  const orderNumber = args.orderId.slice(0, 8).toUpperCase()
  const shortTotal = `$${args.total.toFixed(2)}`
  const buyerFirst = args.buyerName.trim().split(/\s+/)[0] ?? args.buyerName
  return sendEmail({
    to: merchant,
    idempotencyKey: `merchant-new-order:${args.orderId}`,
    subject: `New order · ${shortTotal} · ${buyerFirst || 'guest'}`,
    text: buildText(args, orderNumber, shortTotal),
    html: buildHtml(args, orderNumber, shortTotal),
  })
}

function merchantEmail(site: SiteRow): string | null {
  const contact = (site.config?.contact ?? {}) as { email?: unknown }
  return typeof contact.email === 'string' && contact.email.includes('@') ? contact.email : null
}

/** Best-guess link into the Checked admin surface. Onchecked
 *  is the platform origin; /orders is the online workspace's
 *  ledger. The merchant may still need to sign in; that's fine
 *  as long as the link opens the right destination after they do. */
function ordersLinkHref(): string {
  return 'https://onchecked.app/orders'
}

function buildText(args: MerchantNewOrderArgs, orderNumber: string, shortTotal: string): string {
  const lines: string[] = [
    `New online order — ${shortTotal}`,
    '',
    `Order #${orderNumber}`,
    `From: ${args.buyerName || 'Guest'}${args.buyerEmail ? ` <${args.buyerEmail}>` : ''}`,
  ]
  if (args.buyerPhone) lines.push(`Phone: ${args.buyerPhone}`)
  lines.push(`Fulfillment: ${args.channelLabel}`)
  if (args.shippingLine) lines.push(`Ship to: ${args.shippingLine}`)
  if (args.pickupLabel) lines.push(`Pickup: ${args.pickupLabel}`)
  lines.push('', 'Items:')
  for (const i of args.cart.items) {
    const qty = i.qty > 1 ? ` × ${i.qty}` : ''
    const variant = i.variant_label ? ` (${i.variant_label})` : ''
    lines.push(`  ${i.name}${qty}${variant}  $${i.line_total.toFixed(2)}`)
  }
  lines.push('', `Total: ${shortTotal}`)
  lines.push('', `Open in Checked → ${ordersLinkHref()}`)
  return lines.join('\n')
}

function buildHtml(args: MerchantNewOrderArgs, orderNumber: string, shortTotal: string): string {
  const markUrl = checkedMarkUrl()
  const items = args.cart.items.map(i => {
    const qty = i.qty > 1 ? `<span style="color:#71717A"> × ${i.qty}</span>` : ''
    const variant = i.variant_label
      ? `<div style="font-size:12px;color:#71717A;margin-top:2px;">${escapeHtml(i.variant_label)}</div>`
      : ''
    return `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #E4E4E7;font-size:14px;color:#18181B;">
          ${escapeHtml(i.name)}${qty}
          ${variant}
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #E4E4E7;font-size:14px;color:#18181B;text-align:right;white-space:nowrap;">
          $${i.line_total.toFixed(2)}
        </td>
      </tr>`
  }).join('')

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>New order · ${escapeHtml(shortTotal)}</title>
</head>
<body style="margin:0;padding:0;background:#F4F4F5;font-family:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181B;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:20px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;background:#fff;border:1px solid #E4E4E7;border-radius:14px;overflow:hidden;">

        <!-- Ops header — no shop branding here, this is a system
             notification, not a customer message. -->
        <tr>
          <td style="padding:18px 24px;border-bottom:1px solid #E4E4E7;background:#FAFAF9;">
            <div style="font-family:'Geist Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#71717A;">
              NEW ONLINE ORDER
            </div>
            <div style="margin-top:4px;display:flex;align-items:baseline;gap:8px;">
              <span style="font-family:'Geist Mono',ui-monospace,monospace;font-size:24px;font-weight:600;letter-spacing:-0.03em;color:#18181B;">
                ${escapeHtml(shortTotal)}
              </span>
            </div>
            <div style="margin-top:4px;font-size:12px;color:#71717A;">
              Order #${escapeHtml(orderNumber)}
            </div>
          </td>
        </tr>

        <!-- Buyer + fulfillment -->
        <tr>
          <td style="padding:16px 24px;font-size:13px;color:#3F3F46;line-height:1.55;">
            <div><strong style="color:#18181B;">${escapeHtml(args.buyerName || 'Guest')}</strong>${args.buyerEmail ? ` · <a href="mailto:${escapeHtml(args.buyerEmail)}" style="color:#2563EB;text-decoration:none;">${escapeHtml(args.buyerEmail)}</a>` : ''}${args.buyerPhone ? ` · <a href="tel:${escapeHtml(args.buyerPhone)}" style="color:#2563EB;text-decoration:none;">${escapeHtml(args.buyerPhone)}</a>` : ''}</div>
            <div style="margin-top:6px;">
              <span style="font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#71717A;">${escapeHtml(args.channelLabel)}</span>
              ${args.shippingLine ? ` · ${escapeHtml(args.shippingLine)}` : ''}
              ${args.pickupLabel ? ` · ${escapeHtml(args.pickupLabel)}` : ''}
            </div>
          </td>
        </tr>

        <!-- Items -->
        <tr>
          <td style="padding:8px 24px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${items}
              <tr>
                <td style="padding:12px 0 0;font-size:15px;font-weight:600;color:#18181B;">Total</td>
                <td style="padding:12px 0 0;font-size:15px;font-weight:600;color:#18181B;text-align:right;">${escapeHtml(shortTotal)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA + sign-off. Same Checked signature as the other
             transactional emails so the merchant recognizes it
             as a Checked-produced notification. -->
        <tr>
          <td style="padding:0 24px 20px;">
            <a href="${escapeHtml(ordersLinkHref())}"
               style="display:inline-block;padding:10px 16px;background:#18181B;color:#FAF9F6;border-radius:9px;font-size:13px;font-weight:600;text-decoration:none;">
              Open in Checked →
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 24px 18px;border-top:1px solid #E4E4E7;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:12px;color:#71717A;">
                  System notification
                </td>
                <td align="right" valign="middle">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td valign="middle" style="padding-right:6px;">
                      <span style="font-size:10px;color:#71717A;letter-spacing:0.02em;">Sent through</span>
                    </td>
                    <td valign="middle" style="padding-right:4px;">
                      <img src="${escapeHtml(markUrl)}" alt="" width="12" height="12" style="display:block;border:0;">
                    </td>
                    <td valign="middle">
                      <span style="font-size:12px;font-weight:600;letter-spacing:-0.005em;color:#18181B;">checked</span>
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
