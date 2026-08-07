// ----------------------------------------------------------------
// POST /api/site-cart/checkout   (on tenant host)
//
// Target of the /checkout page's form submit. Consumes a
// multipart/form-data body (name / email / phone / address_*),
// runs performCheckout, and redirects with a 303 See Other:
//   success → /thanks?order=<id>[&unpaid=1]
//   error   → /checkout?checkout_error=<msg>
//
// 303 turns the POST into a GET on the next hop, so a refresh on
// the confirmation page can't double-submit the order.
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
  const name = firstString(formData, 'name') ?? ''
  const email = firstString(formData, 'email') ?? ''
  const phone = firstString(formData, 'phone')
  const line1 = firstString(formData, 'address_line1')
  const line2 = firstString(formData, 'address_line2')
  const city = firstString(formData, 'city')
  const state = firstString(formData, 'state')
  const postal = firstString(formData, 'postal')
  const country = firstString(formData, 'country') ?? 'US'

  const sessionId = (await cookies()).get(CART_COOKIE_NAME)?.value ?? null

  const shipping = line1 && city && state && postal
    ? { line1, line2, city, state, postal, country }
    : undefined

  const result = await performCheckout(site, sessionId, {
    contact: { name, email, phone },
    shipping,
  })

  const base = new URL(req.url)
  if ('error' in result) {
    base.pathname = `/${siteHost}/checkout`
    base.search = ''
    base.searchParams.set('checkout_error', result.error)
    return NextResponse.redirect(base, 303)
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
