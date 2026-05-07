'use client'

// Finance / bank sync step — styled to resemble the real Finance module.

import Link from 'next/link'
import { ConnectBankButton } from '@/components/bank/connect-bank-button'

export default function FinanceStepClient({ plaidConfigured, postPath, opMode }: {
  plaidConfigured: boolean; postPath: string; opMode: 'native_pos' | 'external_pos'
}) {
  const dest = opMode === 'external_pos' ? 'Settings' : 'Menu'

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-5xl">
        {/* Header bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600" />
            <span className="text-sm font-semibold text-gray-900">Setup</span>
          </div>
          <span className="text-xs text-gray-400">Preview 3 of 3</span>
        </div>

        {/* Preview banner */}
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-widest text-blue-600 bg-blue-100 px-2 py-0.5 rounded">Preview</span>
          <p className="text-xs text-blue-700">This is a preview of your Finance workspace. Metrics populate once sales, expenses, and bank data flow in after setup.</p>
        </div>

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Finance</h1>
          <p className="mt-1 text-sm text-gray-500">
            Revenue, expenses, and bank activity in one place. Connect a bank account
            now or skip and come back later.
          </p>
        </div>

        {/* Finance summary cards — empty state resembling real module */}
        <div className="grid gap-4 sm:grid-cols-3 mb-6">
          <MetricCard label="Revenue (30d)" value="$0" sub="Populates after first sale" />
          <MetricCard label="Expenses (30d)" value="$0" sub="Populates after first expense" />
          <MetricCard label="Bank activity" value="\u2014" sub="Requires bank connection" />
        </div>

        {/* Bank connection panel */}
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Bank sync</p>
          </div>
          <div className="p-6">
            <div className="flex items-start gap-6">
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-900">Connect your business bank</p>
                <p className="mt-1.5 text-xs text-gray-500 leading-relaxed max-w-lg">
                  Sync account activity securely through Plaid. Finance will start showing inflow,
                  outflow, and cash movement alongside your sales and expenses.
                </p>
                <ul className="mt-4 space-y-2">
                  <BulletItem>See real money movement, not just manual entries</BulletItem>
                  <BulletItem>Understand cash pressure points across your operation</BulletItem>
                  <BulletItem>Bank data stays server-side and owner-only</BulletItem>
                </ul>
              </div>
            </div>

            <div className="mt-6 pt-5 border-t border-gray-100">
              <ConnectBankButton configured={plaidConfigured} />
            </div>
          </div>
        </div>

        {/* Routing context note */}
        <div className="mt-6 rounded-xl border border-dashed border-amber-200 bg-amber-50/50 p-5">
          <p className="text-xs font-semibold text-amber-700 mb-1">What happens next</p>
          <p className="text-xs text-amber-600/80 leading-relaxed">
            {opMode === 'external_pos'
              ? 'Onboarding is almost done. Next we\u2019ll take you to Settings to integrate your existing POS and import your menu. Finance metrics populate as real data flows in.'
              : 'Onboarding is almost done. Next we\u2019ll take you to Menu to set up your items. Once the menu has real data, native POS becomes available. Finance metrics populate alongside.'}
          </p>
        </div>

        {/* Footer */}
        <div className="mt-8 flex items-center justify-between">
          <Link href={postPath}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
            Skip bank connection for now
          </Link>
          <Link href={postPath}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors">
            Finish setup &middot; go to {dest}
          </Link>
        </div>
      </div>
    </div>
  )
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      <p className="mt-2 text-xl font-bold text-gray-900">{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{sub}</p>
    </div>
  )
}

function BulletItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-xs text-gray-600">
      <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-500" />
      <span>{children}</span>
    </li>
  )
}
