'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { syncPlaidToFinance } from '@/app/actions/finance'

// ----------------------------------------------------------------
// Client-side refresh button for FinanceSyncCard. Fires
// syncPlaidToFinance, surfaces the result count, then refreshes
// the router so the settings page re-reads last-synced timestamps.
// ----------------------------------------------------------------

export default function FinanceRefreshButton({ itemCount }: { itemCount: number }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [running, setRunning] = useState(false)

  const disabled = running || pending

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setMsg(null)
          setRunning(true)
          syncPlaidToFinance()
            .then((res) => {
              if ('error' in res) {
                setMsg({ tone: 'err', text: res.error })
                return
              }
              const d = res.data
              setMsg({
                tone: 'ok',
                text: d
                  ? `Synced ${d.items} item${d.items === 1 ? '' : 's'}. ${d.movementsInserted} new movement${d.movementsInserted === 1 ? '' : 's'}, ${d.transfersPaired} transfer${d.transfersPaired === 1 ? '' : 's'} paired.`
                  : 'Synced.',
              })
              startTransition(() => router.refresh())
            })
            .catch((err) => {
              setMsg({ tone: 'err', text: err?.message ?? 'Sync failed.' })
            })
            .finally(() => setRunning(false))
        }}
        className="inline-flex w-fit items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
      >
        {disabled
          ? 'Refreshing…'
          : `Refresh ${itemCount} connected item${itemCount === 1 ? '' : 's'}`
        }
      </button>
      {msg && (
        <p className={msg.tone === 'ok' ? 'text-sm text-gray-600' : 'text-sm text-red-600'}>
          {msg.text}
        </p>
      )}
    </div>
  )
}
