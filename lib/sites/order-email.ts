// ----------------------------------------------------------------
// Buyer-facing order confirmation for hosted tenant sites.
//
// Sent once per PAID web order, after the orders row and the
// site_orders_link row are both written. Unpaid / 'pending' orders
// are skipped on purpose — those buyers are promised a payment link
// instead, and telling them "we got your order" next to a total
// they haven't paid reads as a receipt for a charge that never
// happened.
//
// Everything visible is driven off the site row, not hardcoded to
// one tenant: name, palette, and the merchant's own contact address
// all come from sites.config. A second tenant gets its own branding
// with no changes here.
//
// Email HTML is deliberately old-fashioned — tables, inline styles,
// no flexbox/grid/custom properties. Gmail, Outlook and Apple Mail
// all strip or ignore modern layout CSS.
// ----------------------------------------------------------------

import { after } from 'next/server'
import { sendEmail, escapeHtml } from '@/lib/email/resend'
import { platformOriginForSlug, absoluteAssetUrl } from './hosts'
import type { SiteRow, SiteDeliveryOption } from './types'
import type { CartSnapshot } from './cart'

export interface OrderConfirmationArgs {
  site: SiteRow
  orderId: string
  /** Restaurant-local calendar date (YYYY-MM-DD) already resolved by
   *  the caller — reformatted here rather than recomputed so the
   *  email always agrees with the sales page. */
  businessDate: string
  buyerEmail: string
  buyerName: string
  cart: CartSnapshot
  delivery: SiteDeliveryOption
  shipping: {
    line1: string
    line2?: string
    city: string
    state: string
    postal: string
    country: string
  } | null
  taxAmount: number
  total: number
  /** Whether the site_orders_link row landed. Does not gate the
   *  send — only rides along in the log so a silent link failure is
   *  visible from the same line that confirms the receipt went out. */
  linkSaved: boolean
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

// Neutral stand-ins only — every key is overridden by the site's own
// theme_colors when present. Kept greyscale on purpose so a site
// that hasn't set a palette looks plain rather than wrongly-branded.
const FALLBACK_PALETTE: Palette = {
  ink: '#18181B',
  body: '#52525B',
  line: '#E4E4E7',
  sand: '#F4F4F5',
  // Soft mint that reads as "brand background" even without a
  // theme_colors override — was greyscale before, so sites that
  // hadn't set sage in config got a neutral gray outer background
  // instead of anything branded. Sites with sage configured will
  // still override this.
  sage: '#E8F0E1',
  muted: '#71717A',
  paper: '#FFFFFF',
  accent: '#18181B',
}

// The storefront loads Outfit from Google Fonts via sites.config
// .head_extras, and global_css sets
//   font-family:"Outfit",ui-sans-serif,system-ui,sans-serif
// on body. We mirror that stack exactly.
//
// The <link>/@import below is best-effort: Apple Mail and iOS Mail
// honour it, Gmail and Outlook strip it. That's fine — the fallback
// chain is a geometric-ish system sans in every client, which is the
// same thing the site falls back to before the webfont lands. Nothing
// depends on Outlook resolving a webfont.
const FONT_STACK = `'Outfit',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=swap'

/** Queue the confirmation to go out after the response is flushed.
 *
 *  Non-blocking by construction: `after()` defers the work until the
 *  buyer already has their success page, so a slow or dead Resend
 *  cannot add latency to checkout, and sendEmail() resolves failures
 *  to values rather than throwing. Nothing this function does can
 *  fail the order.
 *
 *  Exactly-once: the Resend request carries an idempotency key
 *  derived from the order id, so a replayed or retried checkout for
 *  the same order sends one message, not two. */
export function queueOrderConfirmation(args: OrderConfirmationArgs): void {
  after(async () => {
    try {
      const result = await sendOrderConfirmation(args)
      if (result.status === 'sent') {
        console.log('[order-email] sent', { orderId: args.orderId, resendId: result.id, linkSaved: args.linkSaved })
      } else if (result.status === 'skipped') {
        console.warn('[order-email] skipped', { orderId: args.orderId, reason: result.reason, linkSaved: args.linkSaved })
      } else {
        console.error('[order-email] failed', { orderId: args.orderId, error: result.error, linkSaved: args.linkSaved })
      }
    } catch (err) {
      // Belt-and-braces. sendEmail already swallows its own errors;
      // this catches anything the body builders could throw on
      // unexpected data so it can never surface as an unhandled
      // rejection in the function log.
      console.error('[order-email] threw', { orderId: args.orderId, err: String(err) })
    }
  })
}

async function sendOrderConfirmation(args: OrderConfirmationArgs) {
  const siteName = args.site.name || 'Our shop'
  const orderNumber = orderNumberFor(args.orderId)
  return sendEmail({
    to: args.buyerEmail,
    // Replies go to the merchant's own inbox, not to the no-reply
    // sender — a buyer answering "can I add to this order?" should
    // reach the shop.
    replyTo: merchantEmail(args.site),
    idempotencyKey: `order-confirmation:${args.orderId}`,
    subject: `Order ${orderNumber} confirmed — ${siteName}`,
    text: buildText(args, orderNumber, siteName),
    html: buildHtml(args, orderNumber, siteName),
  })
}

/** Short, human-quotable order reference. Orders have no sequence
 *  column, so the app's convention is the leading 8 of the uuid —
 *  same slice the inventory + reconciliation logs use. */
function orderNumberFor(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase()
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

/** Same brand-mark split {{site-header}} uses: first word is the
 *  wordmark, the rest becomes the letterspaced kicker under it, with
 *  config.brand_kicker overriding. Kept in step with
 *  lib/sites/shortcodes/widgets/site-header.ts. */
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

/** Logo resolution mirrors {{site-header}} — config.logo_url, else
 *  the packaged tree mark — then absolutized against the site's own
 *  origin because an email has no base URL to resolve against. */
function logoUrlFor(site: SiteRow, origin: string): string | null {
  const config = (site.config ?? {}) as Record<string, unknown>
  const raw = typeof config.logo_url === 'string' ? config.logo_url : '/assets/logo-tree.png'
  return absoluteAssetUrl(origin, raw)
}

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** Format YYYY-MM-DD without going through Date — parsing a bare
 *  date string yields UTC midnight, which renders as the previous
 *  day for every timezone west of Greenwich. */
function formatBusinessDate(businessDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate)
  if (!m) return businessDate
  const month = MONTHS[Number(m[2]) - 1] ?? ''
  return `${month} ${Number(m[3])}, ${m[1]}`.trim()
}

function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? ''
}

/** Ordered money rows under the line items. Delivery is only shown
 *  when it costs something; a free pickup line is noise. */
function summaryRows(args: OrderConfirmationArgs): Array<[string, string, boolean]> {
  const rows: Array<[string, string, boolean]> = [['Subtotal', money(args.cart.subtotal), false]]
  if (args.delivery.price > 0) rows.push([args.delivery.label, money(args.delivery.price), false])
  if (args.taxAmount > 0) rows.push(['Tax', money(args.taxAmount), false])
  rows.push(['Total', money(args.total), true])
  return rows
}

interface Fulfillment {
  heading: string
  lines: string[]
}

/** Pickup vs ship. The delivery option's own sublabel already
 *  carries the store address for pickup and the carrier/ETA for
 *  shipping, so it is shown in both branches. */
function fulfillmentFor(args: OrderConfirmationArgs): Fulfillment {
  const s = args.shipping
  if (args.delivery.requires_address && s) {
    const cityLine = [s.city, s.state].filter(Boolean).join(', ')
    return {
      heading: 'Shipping to',
      lines: [
        args.buyerName,
        s.line1,
        s.line2 || '',
        [cityLine, s.postal].filter(Boolean).join(' '),
        s.country && s.country.toUpperCase() !== 'US' ? s.country : '',
        args.delivery.sublabel || '',
      ].filter(Boolean),
    }
  }
  return {
    heading: 'Picking up',
    lines: [args.delivery.label, args.delivery.sublabel || '', args.delivery.note || ''].filter(Boolean),
  }
}

// ---------------------------------------------------------------- HTML

function buildHtml(args: OrderConfirmationArgs, orderNumber: string, siteName: string): string {
  const c = palette(args.site)
  const first = firstNameOf(args.buyerName)
  const fulfillment = fulfillmentFor(args)
  const merchant = merchantEmail(args.site)
  const phone = readPhone(args.site)
  // Site's own https origin. Any image_url that comes back as a
  // site-relative path (e.g. "/images/tea.jpg") has to be absolutized
  // before it goes in an email — mail clients have no base URL to
  // resolve relative paths against and would just show a broken image.
  const origin = platformOriginForSlug(args.site.slug)

  const itemRows = args.cart.items.map((i) => {
    const thumb = absoluteAssetUrl(origin, i.image_url)
    // Fixed 56×56 thumb — width/height attributes belt-and-suspender
    // the inline style so mail clients that strip CSS (Outlook,
    // Gmail's stricter rendering paths) still pin the layout size.
    // Source image transfer size is a separate concern — the shop
    // may want to store scaled variants alongside the full-res
    // originals so this doesn't pull ~2 MB per item. See the
    // follow-up note in the commit body.
    const thumbCell = thumb
      ? `<td valign="top" width="72" style="padding:10px 0;border-bottom:1px solid ${c.line};width:72px;">
            <img src="${escapeHtml(thumb)}" alt="" width="56" height="56"
                 style="display:block;width:56px;height:56px;border-radius:8px;object-fit:cover;background:${c.sand};border:0;" />
          </td>`
      : `<td valign="top" width="72" style="padding:10px 0;border-bottom:1px solid ${c.line};width:72px;">
            <div style="width:56px;height:56px;border-radius:8px;background:${c.sand};"></div>
          </td>`
    return `
      <tr>
        ${thumbCell}
        <td valign="middle" style="padding:10px 0;border-bottom:1px solid ${c.line};color:${c.ink};font-size:14px;">
          ${escapeHtml(i.name)}${i.qty > 1 ? `<span style="color:${c.muted};"> × ${i.qty}</span>` : ''}
        </td>
        <td valign="middle" style="padding:10px 0;border-bottom:1px solid ${c.line};color:${c.ink};font-size:14px;text-align:right;white-space:nowrap;">
          ${money(i.line_total)}
        </td>
      </tr>`
  }).join('')

  const totalRows = summaryRows(args).map(([label, value, strong]) => `
      <tr>
        <td colspan="2" style="padding:${strong ? '12px 0 0' : '6px 0 0'};color:${strong ? c.ink : c.body};font-size:${strong ? '16px' : '14px'};font-weight:${strong ? '600' : '400'};">
          ${escapeHtml(label)}
        </td>
        <td style="padding:${strong ? '12px 0 0' : '6px 0 0'};color:${strong ? c.ink : c.body};font-size:${strong ? '16px' : '14px'};font-weight:${strong ? '600' : '400'};text-align:right;white-space:nowrap;">
          ${value}
        </td>
      </tr>`).join('')

  const fulfillmentLines = fulfillment.lines
    .map((l) => `<div style="color:${c.body};font-size:14px;line-height:1.6;">${escapeHtml(l)}</div>`)
    .join('')

  const footerBits = [
    merchant ? `<a href="mailto:${escapeHtml(merchant)}" style="color:${c.body};text-decoration:underline;">${escapeHtml(merchant)}</a>` : '',
    phone ? escapeHtml(phone) : '',
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;')

  const logoUrl = logoUrlFor(args.site, origin)
  const brand = brandMark(args.site)

  // Header brand mark, right-aligned so the layout leads with the
  // "thank you" line on the left. Logo on the left, wordmark +
  // kicker stacked on the right — same treatment {{site-header}}
  // uses on the storefront, just mirrored to sit on the top-right
  // of the card. Rendered as a nested table so email clients that
  // strip flex/inline-block still hold the alignment.
  const headerBlock = `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="border-collapse:collapse;">
          <tr>
            ${logoUrl ? `<td valign="middle" style="padding-right:10px;">
              <img src="${escapeHtml(logoUrl)}" alt="" width="40" height="40"
                   style="display:block;width:40px;height:40px;border:0;" />
            </td>` : ''}
            <td valign="middle" style="text-align:left;">
              <div style="color:${c.ink};font-size:18px;font-weight:600;line-height:1.1;font-family:${FONT_STACK};">
                ${escapeHtml(brand.wordmark)}
              </div>
              ${brand.kicker ? `<div style="color:${c.muted};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;margin-top:3px;font-family:${FONT_STACK};">
                ${escapeHtml(brand.kicker)}
              </div>` : ''}
            </td>
          </tr>
        </table>`

  return `
<div style="margin:0;padding:24px 12px;background:${c.sage};font-family:${FONT_STACK};">
  <link rel="stylesheet" href="${FONT_HREF}" />
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:${c.paper};border-radius:14px;overflow:hidden;">
    <tr>
      <td style="padding:24px 32px 0;">
        ${headerBlock}
      </td>
    </tr>
    <tr>
      <td style="padding:24px 32px 0;">
        <h1 style="margin:0;color:${c.ink};font-size:24px;line-height:1.3;font-weight:600;">
          ${first ? `Thank you, ${escapeHtml(first)}.` : 'Thank you for your order.'}
        </h1>
        <p style="margin:10px 0 0;color:${c.body};font-size:15px;line-height:1.6;">
          Your order is confirmed and paid. Here's what's coming.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 32px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${c.sand};border-radius:10px;">
          <tr>
            <td style="padding:14px 16px;">
              <div style="color:${c.muted};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;">Order</div>
              <div style="color:${c.ink};font-size:15px;font-weight:600;margin-top:2px;">${orderNumber}</div>
            </td>
            <td style="padding:14px 16px;text-align:right;">
              <div style="color:${c.muted};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;">Placed</div>
              <div style="color:${c.ink};font-size:15px;font-weight:600;margin-top:2px;">${escapeHtml(formatBusinessDate(args.businessDate))}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${itemRows}
          ${totalRows}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px 0;">
        <div style="color:${c.muted};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px;">
          ${escapeHtml(fulfillment.heading)}
        </div>
        ${fulfillmentLines}
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px 32px;">
        <div style="border-top:1px solid ${c.line};padding-top:18px;color:${c.muted};font-size:13px;line-height:1.7;">
          Questions about this order? Just reply to this email.
          ${footerBits ? `<div style="margin-top:6px;">${footerBits}</div>` : ''}
        </div>
      </td>
    </tr>
  </table>
</div>`.trim()
}

function readPhone(site: SiteRow): string | null {
  const contact = (site.config?.contact ?? {}) as { phone?: unknown }
  return typeof contact.phone === 'string' && contact.phone.trim() ? contact.phone.trim() : null
}

// ---------------------------------------------------------------- text

function buildText(args: OrderConfirmationArgs, orderNumber: string, siteName: string): string {
  const first = firstNameOf(args.buyerName)
  const fulfillment = fulfillmentFor(args)
  const merchant = merchantEmail(args.site)
  const lines: string[] = [
    siteName,
    '',
    first ? `Thank you, ${first}.` : 'Thank you for your order.',
    "Your order is confirmed and paid. Here's what's coming.",
    '',
    `Order ${orderNumber} · Placed ${formatBusinessDate(args.businessDate)}`,
    '',
  ]
  for (const i of args.cart.items) {
    lines.push(`${i.name}${i.qty > 1 ? ` x ${i.qty}` : ''}  ${money(i.line_total)}`)
  }
  lines.push('')
  for (const [label, value] of summaryRows(args)) {
    lines.push(`${label}: ${value}`)
  }
  lines.push('', fulfillment.heading, ...fulfillment.lines, '')
  lines.push('Questions about this order? Just reply to this email.')
  if (merchant) lines.push(merchant)
  return lines.join('\n')
}
