// ----------------------------------------------------------------
// Shared helpers for shortcode widgets.
//
// Escape functions are load-bearing when interpolating anything
// pulled from site config or a request (site name, nav labels,
// announcement copy). Widgets that emit their own inline markup
// with hardcoded strings still funnel through these so a future
// config swap can't turn text into script.
// ----------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttr(s: string): string {
  return escapeHtml(s)
}
