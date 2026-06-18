// Inventory preview — visually aligned with the real Inventory module.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getOnboardingContext } from '@/app/actions/onboarding'
import { PREVIEW_INVENTORY, type PreviewItem } from '@/lib/onboarding/defaults'
import { getT } from '@/lib/i18n-server'

export default async function PreviewInventoryPage() {
  const ctx = await getOnboardingContext()
  if (!ctx.ok) redirect('/onboarding')
  const t = await getT()

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
            <span className="text-sm font-semibold text-gray-900">{t('Setup', 'Configuración')}</span>
          </div>
          <span className="text-xs text-gray-400">{t('Preview 1 of 3', 'Vista previa 1 de 3')}</span>
        </div>

        {/* Preview banner */}
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-widest text-blue-600 bg-blue-100 px-2 py-0.5 rounded">{t('Preview', 'Vista previa')}</span>
          <p className="text-xs text-blue-700">
            {t(
              'This is a guided preview of your future Inventory workspace. Nothing here is saved yet — real setup happens inside the module.',
              'Esta es una vista guiada de tu futuro espacio de Inventario. Nada aquí se ha guardado — la configuración real ocurre dentro del módulo.'
            )}
          </p>
        </div>

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">{t('Inventory', 'Inventario')}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t(
              'Track stock through counts and movements. Link menu items to recipes and every sale automatically deducts the right quantity.',
              'Lleva el control del stock mediante conteos y movimientos. Vincula los artículos del menú con recetas y cada venta descontará automáticamente la cantidad correcta.'
            )}
          </p>
        </div>

        {/* Status chips row */}
        <div className="flex flex-wrap gap-2 mb-6">
          <StatusChip label={t('Out of stock', 'Sin existencias')} n={out} tone="red" />
          <StatusChip label={t('Low stock', 'Bajo stock')} n={low} tone="amber" />
          <StatusChip label={t('No count', 'Sin conteo')} n={nc} tone="gray" />
          <StatusChip label={t('Total items', 'Total de artículos')} n={items.length} tone="blue" />
        </div>

        {/* Main panel — mirrors actual inventory layout */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Table panel */}
          <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                {t('Inventory items', 'Artículos de inventario')}
              </p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">{t('Item', 'Artículo')}</th>
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">{t('On hand', 'Disponible')}</th>
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">{t('Threshold', 'Umbral')}</th>
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-400">{t('Status', 'Estado')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.name} className={`border-b border-gray-50 last:border-b-0 ${item.name === sel.name ? 'bg-blue-50/40' : ''}`}>
                    <td className="px-5 py-3 font-medium text-gray-900">{item.name}</td>
                    <td className="px-5 py-3 text-gray-600">{item.status === 'no_count' ? '—' : `${item.onHand} ${item.unit}`}</td>
                    <td className="px-5 py-3 text-gray-500">{item.threshold} {item.unit}</td>
                    <td className="px-5 py-3"><Badge s={item.status} label={badgeLabel(item.status, t)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Detail rail */}
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">{t('Item detail', 'Detalle del artículo')}</p>
              <p className="text-lg font-bold text-gray-900">{sel.name}</p>
              <div className="mt-4 space-y-3">
                <DetailRow label={t('On hand', 'Disponible')} value={sel.status === 'no_count' ? '—' : `${sel.onHand} ${sel.unit}`} />
                <DetailRow label={t('Low threshold', 'Umbral mínimo')} value={`${sel.threshold} ${sel.unit}`} />
                <DetailRow label={t('Status', 'Estado')} value={<Badge s={sel.status} label={badgeLabel(sel.status, t)} />} />
              </div>
            </div>

            <div className="rounded-xl border border-dashed border-amber-200 bg-amber-50/50 p-5">
              <p className="text-xs font-semibold text-amber-700 mb-1">{t('Example data only', 'Solo datos de ejemplo')}</p>
              <p className="text-xs text-amber-600/80 leading-relaxed">
                {t(
                  'These items are shaped by your business type as examples. You’ll add real items, record starting counts, and link recipes once you’re inside the Inventory module.',
                  'Estos artículos se generan a partir de tu tipo de negocio como ejemplos. Añadirás artículos reales, registrarás los conteos iniciales y enlazarás recetas una vez dentro del módulo de Inventario.'
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 flex justify-end">
          <Link href="/onboarding/preview-staffing"
            className="px-5 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors">
            {t('Continue to Staffing preview', 'Continuar a la vista previa de Personal')}
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

function badgeLabel(s: PreviewItem['status'], t: (en: string, es?: string) => string): string {
  switch (s) {
    case 'out':      return t('Out', 'Sin existencias')
    case 'low':      return t('Low', 'Bajo')
    case 'ok':       return 'OK'
    case 'no_count': return t('No count', 'Sin conteo')
  }
}

function Badge({ s, label }: { s: PreviewItem['status']; label: string }) {
  const cls: Record<PreviewItem['status'], string> = {
    out: 'bg-red-50 text-red-700',
    low: 'bg-amber-50 text-amber-700',
    ok: 'bg-green-50 text-green-700',
    no_count: 'bg-gray-100 text-gray-500',
  }
  return <span className={`inline-block rounded-lg px-2 py-0.5 text-[11px] font-medium ${cls[s]}`}>{label}</span>
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-900 font-medium">{value}</span>
    </div>
  )
}
