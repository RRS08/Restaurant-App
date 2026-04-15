// ----------------------------------------------------------------
// PageShell Component
//
// A simple wrapper that gives every page a consistent look:
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
// ----------------------------------------------------------------

interface PageShellProps {
  title: string
  description?: string       // optional subtitle line
  children?: React.ReactNode // the page's actual content
}

export default function PageShell({ title, description, children }: PageShellProps) {
  return (
    <div className="max-w-6xl">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        {description && (
          <p className="mt-1 text-gray-500 text-sm">{description}</p>
        )}
      </div>

      {/* Page content */}
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
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
      <p className="text-lg font-medium text-gray-400">{feature}</p>
      <p className="mt-1 text-sm text-gray-300">This module is coming soon.</p>
    </div>
  )
}
