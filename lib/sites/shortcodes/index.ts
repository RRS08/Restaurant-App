// ----------------------------------------------------------------
// Shortcode registry + expander.
//
// A shortcode is a placeholder inside an author-supplied HTML page
// that server-expands to a rendered widget at request time. Syntax
// is Wordpress-inspired:
//
//   {{lead-form form="customer" title="Get a quote"}}
//   {{menu}}
//   {{hours}}
//
// The expander walks the page HTML, finds every `{{…}}` block,
// parses its name + attributes, and swaps the whole block for the
// widget's rendered HTML. Widgets are pure server functions —
// they receive the parsed args + a small render context (the
// resolved site, page, and request host) and return an HTML
// string. Errors don't blow up the whole page — a widget that
// throws just leaves a small inline notice in place.
//
// Add a shortcode by dropping a file in `./widgets/*.ts` that
// default-exports the widget and registering it here.
// ----------------------------------------------------------------

import type { SiteRow, SitePageRow } from '../types'
import { renderLeadForm } from './widgets/lead-form'

export interface ShortcodeContext {
  site: SiteRow
  page: SitePageRow
  host: string
  /** URL search params from the incoming request. Widgets that
   *  react to `?category=…` read from here. */
  query: Record<string, string>
  /** Params captured from a dynamic path pattern (`/shop/:slug` →
   *  `{ slug: 'passiflora-night' }`). Empty on static-path pages. */
  params: Record<string, string>
}

export type ShortcodeArgs = Record<string, string | boolean>

export type ShortcodeRenderer = (args: ShortcodeArgs, ctx: ShortcodeContext) => Promise<string> | string

/** Registry of every shortcode name → its renderer. Add entries
 *  here as new widgets land. Unknown names render an inline
 *  notice so authors see the typo instead of nothing at all. */
const REGISTRY: Record<string, ShortcodeRenderer> = {
  'lead-form': renderLeadForm,
}

const SHORTCODE_RE = /\{\{\s*([a-z][a-z0-9-]*)((?:\s+[a-z][a-z0-9-]*(?:=(?:"[^"]*"|'[^']*'|[^\s}]+))?)*)\s*\}\}/gi

/** Walk the input HTML replacing every shortcode with its
 *  rendered output. Runs sequentially so widget errors don't
 *  cascade — one bad shortcode leaves a tiny inline notice; the
 *  rest of the page still renders. */
export async function expandShortcodes(html: string, ctx: ShortcodeContext): Promise<string> {
  const matches: Array<{ start: number; end: number; name: string; args: ShortcodeArgs }> = []
  SHORTCODE_RE.lastIndex = 0
  for (let m = SHORTCODE_RE.exec(html); m; m = SHORTCODE_RE.exec(html)) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      name: m[1].toLowerCase(),
      args: substituteArgs(parseArgs(m[2] ?? ''), ctx),
    })
  }
  if (matches.length === 0) return html

  const parts: string[] = []
  let cursor = 0
  for (const match of matches) {
    parts.push(html.slice(cursor, match.start))
    const renderer = REGISTRY[match.name]
    if (!renderer) {
      parts.push(inlineNotice(`unknown shortcode: ${match.name}`))
    } else {
      try {
        const out = await renderer(match.args, ctx)
        parts.push(typeof out === 'string' ? out : '')
      } catch (err) {
        console.error(`[shortcode:${match.name}] render failed`, err)
        parts.push(inlineNotice(`${match.name} failed to render`))
      }
    }
    cursor = match.end
  }
  parts.push(html.slice(cursor))
  return parts.join('')
}

/** Parse `key="value" flag other='x'` into a plain map. Bare
 *  flags (no `=`) become `true`. Unquoted values allow any run
 *  of non-whitespace, non-`}` chars. */
function parseArgs(raw: string): ShortcodeArgs {
  const out: ShortcodeArgs = {}
  const attrRe = /([a-z][a-z0-9-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s}]+)))?/gi
  for (let m = attrRe.exec(raw); m; m = attrRe.exec(raw)) {
    const key = m[1].toLowerCase()
    const value = m[2] ?? m[3] ?? m[4]
    out[key] = value === undefined ? true : value
  }
  return out
}

/** Small, unstyled comment-shaped notice used when a shortcode
 *  can't render. Visible in view-source, invisible on the page. */
function inlineNotice(msg: string): string {
  return `<!-- checked-sites: ${msg.replace(/-->/g, '-- >')} -->`
}

/** Substitute request-context placeholders inside a shortcode's
 *  attribute values. Only string values are touched — bare-flag
 *  booleans pass through. Supported forms:
 *
 *    {{query.<name>}}   →  ctx.query[name]   (URL search params)
 *    {{params.<name>}}  →  ctx.params[name]  (dynamic path captures)
 *
 *  A missing key substitutes to the empty string, so a widget with
 *  `category="{{query.category}}"` on a URL without `?category=`
 *  receives `category: ""` rather than the literal placeholder — the
 *  widget can then treat empty as "no filter". */
const PLACEHOLDER_RE = /\{\{\s*(query|params)\.([a-z][a-z0-9_-]*)\s*\}\}/gi

function substituteArgs(args: ShortcodeArgs, ctx: ShortcodeContext): ShortcodeArgs {
  const out: ShortcodeArgs = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      out[key] = value
      continue
    }
    out[key] = value.replace(PLACEHOLDER_RE, (_, kind: string, name: string) => {
      const src = kind.toLowerCase() === 'query' ? ctx.query : ctx.params
      const v = src[name]
      return typeof v === 'string' ? v : ''
    })
  }
  return out
}
