// ----------------------------------------------------------------
// POST /api/site-cart/checkout   (on tenant host)
//
// Consumes the multi-step checkout form's flat body (all steps
// submit at once — the reveal is client-side only), runs
// performCheckout, and 303-redirects:
//   hosted URL returned → straight to the provider's payment page
//   otherwise           → /thanks?order=<id>&unpaid=1
//   error               → /checkout?checkout_error=<msg>
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { cookies, headers } from 'next/headers'
import { isMainHost, normalizeHost } from '@/lib/sites/hosts'
import { resolveSiteByHost } from '@/lib/sites/render'
import { CART_COOKIE_NAME } from '@/lib/sites/cart'
import { performCheckout } from '@/lib/sites/checkout'

interface Ctx { params: Promise<{ siteHost: string }> }

export async function POST(req: Request, { params }: Ctx) {
  const requestHost = normalizeHost((await headers()).get('host'))
  if (isMainHost(requestHost)) {
    return new NextResponse('not found', { status: 404 })
  }

  const { siteHost } = await params
  const site = await resolveSiteByHost(siteHost)
  if (!site) return new NextResponse('site not found', { status: 404 })

  const formData = await req.formData()
  const email = firstString(formData, 'email') ?? ''
  // Widget renders a single Full-name field (works around a Chrome
  // Address-autofill bug where the whole recipient name gets dumped
  // into whichever of first/last name it decides to fill). We split
  // on the first space so downstream code (orders.customer_name,
  // site_orders_link.contact) still gets first + last.
  const fullName = firstString(formData, 'full_name') ?? ''
  const nameParts = fullName.split(/\s+/).filter(Boolean)
  const firstName = nameParts[0] ?? ''
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''
  const phone = firstString(formData, 'phone')
  const deliveryOptionKey = firstString(formData, 'delivery_option') ?? ''
  const line1 = firstString(formData, 'address_line1')
  const line2 = firstString(formData, 'address_line2')
  const city = firstString(formData, 'city')
  const state = firstString(formData, 'state')
  const postal = firstString(formData, 'postal')
  const country = firstString(formData, 'country') ?? 'US'
  const notes = firstString(formData, 'notes')
  // billing_same checkbox is CHECKED by default in the widget and
  // only reaches us when checked (unchecked checkboxes send nothing).
  // Absent field = user unchecked it = billing address is separate.
  const billingSame = firstString(formData, 'billing_same') === '1'
  const optIn = firstString(formData, 'opt_in_marketing') === '1'
  const nonce = firstString(formData, 'poynt_collect_nonce')
  const cardholderName = firstString(formData, 'cardholder_name')
  const billingLine1 = firstString(formData, 'billing_line1')
  const billingLine2 = firstString(formData, 'billing_line2')
  const billingCity = firstString(formData, 'billing_city')
  const billingState = firstString(formData, 'billing_state')
  const billingPostal = firstString(formData, 'billing_postal')

  const sessionId = (await cookies()).get(CART_COOKIE_NAME)?.value ?? null

  const shipping = line1 && city && state && postal
    ? { line1, line2, city, state, postal, country }
    : undefined

  // Only forward billing when the buyer opted OUT of "same as delivery"
  // AND the required fields came through. performCheckout drops it
  // when billing_same is true, but guarding here keeps a stale hidden
  // block (JS disabled edge case) from writing a half-populated addr.
  const billing = !billingSame && billingLine1 && billingCity && billingState && billingPostal
    ? { line1: billingLine1, line2: billingLine2, city: billingCity, state: billingState, postal: billingPostal }
    : undefined

  const result = await performCheckout(site, sessionId, {
    contact: {
      email,
      first_name: firstName,
      last_name: lastName,
      phone,
    },
    delivery_option_key: deliveryOptionKey,
    shipping,
    billing_same: billingSame,
    cardholder_name: cardholderName,
    billing,
    notes,
    opt_in_marketing: optIn,
    nonce,
  })

  const base = new URL(req.url)
  if ('error' in result) {
    base.pathname = `/${siteHost}/checkout`
    base.search = ''
    base.searchParams.set('checkout_error', result.error)
    return NextResponse.redirect(base, 303)
  }

  // Hosted-checkout URL beats the /thanks flow when the provider
  // returned one — buyer pays there and comes back via the
  // successUrl the adapter passed. When unavailable (stub), fall
  // through to the deferred-payment /thanks message.
  if (result.hostedUrl) {
    return NextResponse.redirect(result.hostedUrl, 303)
  }

  base.pathname = `/${siteHost}/thanks`
  base.search = ''
  base.searchParams.set('order', result.orderId)
  if (result.paymentStatus === 'unpaid') base.searchParams.set('unpaid', '1')
  return NextResponse.redirect(base, 303)
}

function firstString(fd: FormData, key: string): string | undefined {
  const v = fd.get(key)
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}
