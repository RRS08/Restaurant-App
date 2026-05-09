// Inventory preview — visually aligned with the real Inventory module.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getOnboardingContext } from '@/app/actions/onboarding'
import { PREVIEW_INVENTORY, type PreviewItem } from '@/lib/onboarding/defaults'

export default async function PreviewInventoryPage() {
  const ctx = await getOnboardingContext()
  if (!ctx.ok) redirect('/onboarding')

  const items = PREVIEW_INVENTORY[ctx.businessType]
  const out = items.filter(i => i.status === 'out').length
  const low = items.filter(i => i.status === 'low').length
  const nc = items.filter(i => i.status === 'no_count').length
  const sel = items.find(i => i.status === 'low') ?? items[0]

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-5xl">
        {/* Header bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600" />
            <span className="text-sm font-semibold text-gray-900">Setup</span>
          </div>
          <span className="text-xs text-gray-400">Preview 1 of 3</span>
        </div>

        {/* Preview banner */}
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-widest text-blue-600 bg-blue-100 px-2 py-0.5 rounded">Preview</span>
          <p className="text-xs text-blue-700">This is a guided preview of your future Inventory workspace. Nothing here is saved yet — real setup happens inside the module.</p>
        </div>

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="mt-1 text-sm text-gray-500">
            Track stock through counts and movements. Link menu items to recipes and every
            sale automatically deducts the right quantity.
          </p>
        </div>

        {/* Status chips row */}
        <div className="flex flex-wrap gap-2 mb-6">
          <StatusChip label="Out of stock" n={out} tone="red" />
          <StatusChip label="Low stock" n={low} tone="amber" />
          <StatusChip label="No count" n={nc} tone="gray" />
          <StatusChip label="Total items" n={items.length} tone="blue" />
        </div>

        {/* Main panel — mirrors actual inventory layout */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Table panel */}
          <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                Inventory items
              </p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">Item</th>
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">On hand</th>
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">Threshold</th>
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={item.name} className={`border-b border-gray-50 last:border-b-0 ${item.name === sel.name ? 'bg-blue-50/40' : ''}`}>
                    <td className="px-5 py-3 font-medium text-gray-900">{item.name}</td>
                    <td className="px-5 py-3 text-gray-600">{item.status === 'no_count' ? '\u2014' : `${item.onHand} ${item.unit}`}</td>
                    <td className="px-5 py-3 text-gray-500">{item.threshold} {item.unit}</td>
                    <td className="px-5 py-3"><Badge s={item.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Detail rail */}
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">Item detail</p>
              <p className="text-lg font-bold text-gray-900">{sel.name}</p>
              <div className="mt-4 space-y-3">
                <DetailRow label="On hand" value={sel.status === 'no_count' ? '\u2014' : `${sel.onHand} ${sel.unit}`} />
                <DetailRow label="Low threshold" value={`${sel.threshold} ${sel.unit}`} />
                <DetailRow label="Status" value={<Badge s={sel.status} />} />
              </div>
            </div>

            <div className="rounded-xl border border-dashed border-amber-200 bg-amber-50/50 p-5">
              <p className="text-xs font-semibold text-amber-700 mb-1">Example data only</p>
              <p className="text-xs text-amber-600/80 leading-relaxed">
                These items are shaped by your business type as examples.
                You&apos;ll add real items, record starting counts, and link
                recipes once you&apos;re inside the Inventory module.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 flex justify-end">
          <Link href="/onboarding/preview-staffing"
            className="px-5 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors">
            Continue to Staffing preview
          </Link>
        </div>
      </div>
    </div>
  )
}

function StatusChip({ label, n, tone }: { label: string; n: number; tone: 'red' | 'amber' | 'gray' | 'blue' }) {
  const cls: Record<typeof tone, string> = {
    red: 'bg-red-50 text-red-700 border-red-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    gray: 'bg-gray-100 text-gray-600 border-gray-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
  }
  return <span className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${cls[tone]}`}>{label} <span className="font-bold">{n}</span></span>
}

function Badge({ s }: { s: PreviewItem['status'] }) {
  const m: Record<typeof s, [string, string]> = {
    out: ['Out', 'bg-red-50 text-red-700'],
    low: ['Low', 'bg-amber-50 text-amber-700'],
    ok: ['OK', 'bg-green-50 text-green-700'],
    no_count: ['No count', 'bg-gray-100 text-gray-500'],
  }
  return <span className={`inline-block rounded-lg px-2 py-0.5 text-[11px] font-medium ${m[s][1]}`}>{m[s][0]}</span>
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-900 font-medium">{value}</span>
    </div>
  )
}
