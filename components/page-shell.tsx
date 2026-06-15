// ----------------------------------------------------------------
// PageShell Component
//
// A simple wrapper that gives every page a consistent look:
//   - an optional uppercase mono `eyebrow` (site texture echo of
//     the marketing surfaces)
//   - a title at the top
//   - an optional subtitle
//   - the page content below
//
// WHY a shared component?
//   Without it, every page would repeat the same title/subtitle
//   markup. If you later want to change the heading style, you'd
//   have to edit 6 files. With PageShell, you change one place.
//
// This is a Server Component (no 'use client') because it doesn't
// need any interactivity — it just wraps content.
//
// Brand tokens used:
//   text-zinc-900   ink, headline weight
//   text-slate      muted body / eyebrow (from --color-slate)
//   border-hairline warm divider (from --color-hairline)
// ----------------------------------------------------------------

interface PageShellProps {
  title: string
  description?: string
  /** Optional mono label above the title (site texture). */
  eyebrow?: string
  children?: React.ReactNode
}

export default function PageShell({ title, description, eyebrow, children }: PageShellProps) {
  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        {eyebrow && (
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate mb-2">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate">{description}</p>}
      </div>
      {children}
    </div>
  )
}

// ----------------------------------------------------------------
// ComingSoon — a reusable placeholder card
//
// Used on every module page that isn't built yet.
// When you build a real module, just replace <ComingSoon /> with
// the real content.
// ----------------------------------------------------------------
export function ComingSoon({ feature }: { feature: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-hairline bg-white p-16 text-center">
      <p className="text-lg font-medium text-zinc-400">{feature}</p>
      <p className="mt-1 text-sm text-zinc-300">This module is coming soon.</p>
    </div>
  )
}
