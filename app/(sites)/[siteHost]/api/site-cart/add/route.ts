// ----------------------------------------------------------------
// POST /api/site-cart/add   (on tenant host)
//
// Increments a slug's qty in the visitor's cart, creating the
// session cookie + row on first add. Returns the new total count
// so the client can update every .cart-count badge.
//
// Body: { slug: string, qty: number }
// 200:  { ok: true, count: number }
// 400:  { error: 'invalid body' | 'quantity must be a positive integer' | 'unknown product' }
// 404:  { error: 'site not found' } | { error: 'not found' } (main-host guard)
//
// Same tenant-illusion guard as the render route — this endpoint
// is meaningful only under a tenant hostname. The (sites) route
// group is still reachable at /<siteHost>/api/… on the main host
// via direct path access, so we 404 there defensively.
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { cookies, headers } from 'next/headers'
import { isMainHost, normalizeHost } from '@/lib/sites/hosts'
import { resolveSiteByHost } from '@/lib/sites/render'
import { addToCart, CART_COOKIE_NAME, CART_COOKIE_MAX_AGE_SECONDS } from '@/lib/sites/cart'
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

  // Options payload is optional — cart lib fills in defaults when
  // the product has a picker but the client omitted the selection
  // (e.g. a card-grid Add-button click). normalizeOptions strips
  // anything not string→string so we never trust the wire shape.
  const options = normalizeOptions((body as { options?: unknown }).options)
  const result = await addToCart(site.id, existingSession, body.slug, body.qty, options)
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
