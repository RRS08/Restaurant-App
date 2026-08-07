// ----------------------------------------------------------------
// {{locations}} widget.
//
// Renders every location card the site has, in stored order.
// Locations live on `site.config.locations` as an array of:
//
//   {
//     "name": "Mercado District",
//     "status": "open" | "coming-soon",
//     "status_label": "Opening October",   // shown on coming-soon
//     "addr1": "4400 N 23rd St, Suite 197",
//     "addr2": "McAllen, TX 78504",
//     "phone": "(956) 805-0668",
//     "hours": "Tue–Fri · 12–9pm\nSat · 12–10pm\n…",  // real \n
//     "image_url": "/assets/hero.jpg" | null,
//     "maps_url":  "https://maps.google.com/…"
//   }
//
// Behavior:
//   - status: open → renders <img>, badge reads "Open now".
//   - status: coming-soon with image_url → same as open (photo).
//   - status: coming-soon without image → the placeholder tile
//     (.loc-soon) with the status_label + name.
//   - hours renders inside <dd> with white-space: pre-line, so real
//     newlines in the string become line breaks. Do not convert to
//     <br> before writing.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { escapeAttr, escapeHtml } from '../utils'

interface Location {
  name?: string
  status?: 'open' | 'coming-soon' | string
  status_label?: string
  addr1?: string
  addr2?: string
  phone?: string
  hours?: string
  image_url?: string | null
  maps_url?: string
}

export function renderLocations(_args: unknown, ctx: ShortcodeContext): string {
  const config = (ctx.site.config ?? {}) as Record<string, unknown>
  const raw = Array.isArray(config.locations) ? (config.locations as Location[]) : []
  if (raw.length === 0) return '<div class="loc-grid"></div>'

  return `<div class="loc-grid">
${raw.map(renderCard).join('\n')}
</div>`
}

function renderCard(loc: Location): string {
  const isOpen = loc.status === 'open'
  const hasImage = typeof loc.image_url === 'string' && loc.image_url.length > 0
  const badgeText = isOpen ? 'Open now' : (loc.status_label ?? 'Opening soon')
  const badgeClass = isOpen ? 'open' : 'soon'

  // Photo tile when we have one; placeholder tile when we don't.
  // The placeholder shows the coming-soon label + city so a shop
  // that's announced but pre-open still reads as a real location
  // rather than a broken card.
  const media = hasImage
    ? `<img src="${escapeAttr(loc.image_url as string)}" alt="${escapeAttr(loc.name ?? '')}">`
    : `<div class="loc-soon"><strong>${escapeHtml(loc.status_label ?? 'Opening soon')}</strong><span>${escapeHtml(loc.name ?? '')}</span></div>`

  const addrLines: string[] = []
  if (loc.addr1) addrLines.push(escapeHtml(loc.addr1))
  if (loc.addr2) addrLines.push(escapeHtml(loc.addr2))
  const addrBlock = addrLines.length > 0
    ? `<div class="loc-addr">${addrLines.join('<br>')}</div>`
    : ''
  const phoneBlock = loc.phone ? `<div class="loc-addr">${escapeHtml(loc.phone)}</div>` : ''

  const hoursBlock = loc.hours
    ? `<dl class="loc-hours"><dt>Hours</dt><dd>${escapeHtml(loc.hours)}</dd></dl>`
    : ''

  const mapsLink = loc.maps_url
    ? `<a class="link-underline" href="${escapeAttr(loc.maps_url)}" target="_blank" rel="noopener noreferrer">Get directions →</a>`
    : ''

  return `<div class="loc-card">
  ${media}
  <div class="loc-body">
    <div class="loc-title">
      <h2>${escapeHtml(loc.name ?? '')}</h2>
      <span class="loc-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
    </div>
    ${addrBlock}
    ${phoneBlock}
    ${hoursBlock}
    ${mapsLink}
  </div>
</div>`
}
