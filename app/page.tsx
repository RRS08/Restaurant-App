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

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">

      {/* Top nav */}
      <header className="px-8 py-5 flex items-center justify-between border-b border-gray-100">
        <span className="font-bold text-gray-900 text-lg">RestaurantApp</span>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="text-sm font-semibold bg-blue-600 text-white px-4 py-2 rounded-lg
                       hover:bg-blue-700 transition-colors"
          >
            Get started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center justify-center px-8">
        <div className="text-center max-w-xl">
          <h1 className="text-4xl font-bold text-gray-900 leading-tight">
            Restaurant operations,
            <br />
            simplified
          </h1>
          <p className="mt-4 text-lg text-gray-500">
            Manage your restaurant from one place. Sales, inventory, staffing,
            and more — built for teams of any size.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link
              href="/signup"
              className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl
                         hover:bg-blue-700 transition-colors"
            >
              Start for free
            </Link>
            <Link
              href="/login"
              className="px-6 py-3 border border-gray-200 text-gray-700 font-semibold
                         rounded-xl hover:bg-gray-50 transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      </main>

    </div>
  )
}
