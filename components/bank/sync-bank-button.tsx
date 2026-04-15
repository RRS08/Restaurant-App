'use client'

import { useActionState } from 'react'
import { syncBankTransactions, disconnectBank } from '@/app/actions/bank'

type Result = { ok: true; message: string } | { error: string } | null

export function SyncBankButton() {
  const [state, formAction, pending] = useActionState<Result, FormData>(syncBankTransactions, null)
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-fit items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
      >
        {pending ? 'Syncing…' : 'Sync transactions'}
      </button>
      {state && 'error' in state && <p className="text-sm text-red-600">{state.error}</p>}
      {state && 'ok' in state && <p className="text-sm text-gray-600">{state.message}</p>}
    </form>
  )
}

export function DisconnectBankButton({ providerItemId }: { providerItemId: string }) {
  const [state, formAction, pending] = useActionState<Result, FormData>(disconnectBank, null)
  return (
    <form action={formAction}>
      <input type="hidden" name="provider_item_id" value={providerItemId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
      >
        {pending ? 'Disconnecting…' : 'Disconnect'}
      </button>
      {state && 'error' in state && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </form>
  )
}
