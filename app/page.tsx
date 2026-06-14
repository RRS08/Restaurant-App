// ----------------------------------------------------------------
// Landing Page  →  /
//
// This is the public home page — visible to everyone, logged in or not.
// proxy.ts does NOT redirect logged-in users away from this page,
// so it's fine to have a "Sign in" and "Get started" button here.
//
// When you're ready, you can turn this into a real marketing page.
// For now it's a clean placeholder that directs users to sign up or log in.
// ----------------------------------------------------------------

import Link from 'next/link'
import { BrandLockup, BrandWordmark } from '@/components/brand'

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#FAF9F6] flex flex-col">

      {/* Top nav */}
      <header className="px-8 py-5 flex items-center justify-between border-b border-gray-200/60">
        <Link href="/" className="inline-flex">
          <BrandLockup size="md" variant="flat" />
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="text-sm font-semibold bg-[#18181B] text-white px-4 py-2 rounded-lg
                       hover:bg-[#2a2a2f] transition-colors"
          >
            Get started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center justify-center px-8">
        <div className="text-center max-w-xl">
          <h1 className="text-5xl font-bold text-[#18181B] leading-[1.05] tracking-[-0.02em]">
            Restaurant operations,
            <br />
            <span className="text-[#6B6B70]">checked.</span>
          </h1>
          <p className="mt-5 text-lg text-gray-600 leading-relaxed">
            Sales, inventory, staffing, and finance — one surface, one truth, one tap to
            the next thing that needs attention.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link
              href="/signup"
              className="px-6 py-3 bg-[#18181B] text-white font-semibold rounded-xl
                         hover:bg-[#2a2a2f] transition-colors"
            >
              Start for free
            </Link>
            <Link
              href="/login"
              className="px-6 py-3 border border-gray-300 text-gray-800 font-semibold
                         rounded-xl hover:bg-white transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      </main>

      {/* Footer wordmark — calm closer for the page. */}
      <footer className="px-8 py-6 flex items-center justify-center">
        <BrandWordmark size="sm" className="text-gray-400" />
      </footer>

    </div>
  )
}
