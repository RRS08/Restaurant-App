// ----------------------------------------------------------------
// {{cart-count}} widget.
//
// Emits the badge span the header + client JS both read from. The
// count itself is always rendered — never hidden — because the
// design's transitions rely on the element being present.
//
// Server-side cart state doesn't exist yet (v1 uses a client-only
// cart the /shop and PDP buttons prime via fetch), so the initial
// value is `0`. When the server-side cart lands, this widget will
// read the current count from the request context; the DOM shape
// stays identical so no page change is needed.
// ----------------------------------------------------------------

export function renderCartCount(): string {
  return '<span class="cart-count">0</span>'
}
