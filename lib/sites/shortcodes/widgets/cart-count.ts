// ----------------------------------------------------------------
// {{cart-count}} widget.
//
// Emits the badge span the header + client JS both read from. The
// count itself is always rendered — never hidden — because the
// design's transitions rely on the element being present. Value
// comes from ctx.cartCount, which the route handler precomputes
// once per pageview so multiple {{cart-count}} on the same page
// share a single DB lookup.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'

export function renderCartCount(_args: unknown, ctx: ShortcodeContext): string {
  return `<span class="cart-count">${ctx.cartCount}</span>`
}
