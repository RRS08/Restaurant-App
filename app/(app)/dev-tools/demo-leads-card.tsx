'use client'

// ----------------------------------------------------------------
// DemoLeadsCard — dev-only feed of recent "Book a demo" submissions.
//
// Sorted newest-first, capped at 50 rows. Each row shows email,
// concept, IP, the truncated UA, and whether the server rejected
// it (honeypot / rate_limit / turnstile). Rejected rows surface in
// red so spam attempts pop visually.
//
// No CRUD here — just a read pane. If you want to delete spam
// rows, do it from the Supabase dashboard.
// ----------------------------------------------------------------

import type { DemoLeadRow } from '@/app/actions/demo-leads'

interface Props {
  leads: DemoLeadRow[]
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  const now = Date.now()
  const diffMin = Math.floor((now - d.getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function DemoLeadsCard({ leads }: Props) {
  const accepted = leads.filter((l) => !l.rejected)
  const rejected = leads.filter((l) => l.rejected)

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700">
          Demo leads
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-600">
          {accepted.length} good · {rejected.length} filtered
        </p>
      </div>
      <p className="mt-1.5 text-base font-semibold text-gray-900">
        Who reached out from the marketing site.
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
        Newest 50 submissions, including bots the honeypot caught. Rejected rows are kept on
        purpose so we can see attack patterns; they’re tagged with the reason in red.
      </p>

      {leads.length === 0 ? (
        <p className="mt-4 text-[13px] text-gray-500 italic">
          No leads yet. The first prospect who fills out the marketing form will show up here.
        </p>
      ) : (
        <div className="mt-4 space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
          {leads.map((l) => (
            <div
              key={l.id}
              className={
                'flex items-baseline justify-between gap-3 px-3 py-2 rounded-lg border ' +
                (l.rejected
                  ? 'border-red-200 bg-red-50/60'
                  : 'border-emerald-200/70 bg-white')
              }
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={'text-sm font-semibold ' + (l.rejected ? 'text-red-900' : 'text-gray-900')}>
                    {l.email}
                  </span>
                  {l.concept && (
                    <span className="text-[11px] text-gray-500 font-mono">· {l.concept}</span>
                  )}
                  {l.rejected && (
                    <span className="text-[10px] font-semibold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                      {l.rejectionReason ?? 'rejected'}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10.5px] font-mono text-gray-400 flex-wrap">
                  <span>{formatWhen(l.createdAt)}</span>
                  {l.ipAddress && <span>· {l.ipAddress}</span>}
                  {l.userAgent && (
                    <span className="truncate max-w-[260px]" title={l.userAgent}>
                      · {l.userAgent.slice(0, 50)}{l.userAgent.length > 50 ? '…' : ''}
                    </span>
                  )}
                </div>
                {l.message && (
                  <p className="mt-1 text-[12.5px] text-gray-700 leading-relaxed">
                    {l.message}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
