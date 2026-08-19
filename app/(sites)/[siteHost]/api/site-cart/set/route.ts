// ----------------------------------------------------------------
// POST /api/site-cart/set   (on tenant host)
//
// Sets (or removes) a slug's qty in the visitor's cart. qty=0
// removes the line. Used by the cart-page stepper +/- and the
// Remove button. Same body/response shape as /add.
//
// Body: { slug: string, qty: number }  // qty >= 0
// 200:  { ok: true, count: number }
// 400:  { error: … }
// 404:  { error: 'site not found' } | { error: 'not found' }
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { cookies, headers } from 'next/headers'
import { isMainHost, normalizeHost } from '@/lib/sites/hosts'
import { resolveSiteByHost } from '@/lib/sites/render'
import { setCartItem, CART_COOKIE_NAME, CART_COOKIE_MAX_AGE_SECONDS } from '@/lib/sites/cart'
import { normalizeOptions } from '@/lib/sites/cart-options'

interface Ctx { params: Promise<{ siteHost: string }> }

export async function POST(req: Request, { params }: Ctx) {
  const requestHost = normalizeHost((await headers()).get('host'))
  if (isMainHost(requestHost)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const { siteHost } = await params
  const site = await resolveSiteByHost(siteHost)
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body.slug !== 'string' || typeof body.qty !== 'number') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const cookieStore = await cookies()
  const existingSession = cookieStore.get(CART_COOKIE_NAME)?.value ?? null

  // options identifies WHICH line to update when the same slug
  // appears more than once (loose leaf + tea bags of the same tea).
  // Optional — a set() against a no-picker product just omits it.
  const options = normalizeOptions((body as { options?: unknown }).options)
  const result = await setCartItem(site.id, existingSession, body.slug, body.qty, options)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })

  const res = NextResponse.json({ ok: true, count: result.count })
  if (result.sessionId !== existingSession) {
    res.cookies.set(CART_COOKIE_NAME, result.sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: CART_COOKIE_MAX_AGE_SECONDS,
    })
  }
  return res
}
