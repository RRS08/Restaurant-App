import { createClient } from '@/lib/supabase/server'
import { ConnectBankButton } from '@/components/bank/connect-bank-button'
import { SyncBankButton, DisconnectBankButton } from '@/components/bank/sync-bank-button'
import { isPlaidConfigured } from '@/lib/plaid/client'

// ----------------------------------------------------------------
// BankCard — owner-only Settings section for Plaid Sandbox bank
// connectivity. Lists connected accounts grouped by Plaid Item so
// the disconnect button can target a whole connection at once.
//
// Renders nothing when the current user isn't an owner of any
// restaurant — the parent Settings page decides when to mount it.
// ----------------------------------------------------------------

interface AccountRow {
  id: string
  provider_item_id: string | null
  provider_account_id: string
  account_name: string | null
  account_mask: string | null
  account_subtype: string | null
  institution_name: string | null
  last_synced_at: string | null
  active: boolean
}

export default async function BankCard({ restaurantId }: { restaurantId: string }) {
  const configured = isPlaidConfigured()
  const supabase = await createClient()
  const { data } = await supabase
    .from('connected_bank_accounts')
    .select('id, provider_item_id, provider_account_id, account_name, account_mask, account_subtype, institution_name, last_synced_at, active')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .eq('active', true)
    .order('created_at', { ascending: true })

  const accounts = (data ?? []) as AccountRow[]

  // Group by Plaid Item so each connection renders as a block.
  const items = new Map<string, AccountRow[]>()
  for (const a of accounts) {
    if (!a.provider_item_id) continue
    const bucket = items.get(a.provider_item_id) ?? []
    bucket.push(a)
    items.set(a.provider_item_id, bucket)
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-900">Bank connections</h3>
        <p className="mt-1 text-xs text-gray-500">
          Plaid Sandbox only. Access tokens stay server-side; managers cannot view or manage these connections.
        </p>
      </div>

      {items.size === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 p-4 text-sm text-gray-500">
          No bank connected yet.
        </div>
      ) : (
        <ul className="mb-5 space-y-4">
          {Array.from(items.entries()).map(([itemId, rows]) => (
            <li key={itemId} className="rounded-md border border-gray-200 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {rows[0].institution_name ?? 'Bank'}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Last synced:{' '}
                    {rows[0].last_synced_at
                      ? new Date(rows[0].last_synced_at).toLocaleString()
                      : 'never'}
                  </p>
                </div>
                <DisconnectBankButton providerItemId={itemId} />
              </div>
              <ul className="mt-3 space-y-1">
                {rows.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-xs text-gray-600">
                    <span>
                      {a.account_name ?? 'Account'}
                      {a.account_mask ? ` ••${a.account_mask}` : ''}
                    </span>
                    <span className="text-gray-400">{a.account_subtype ?? ''}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <ConnectBankButton configured={configured} />
        {items.size > 0 && configured && <SyncBankButton />}
      </div>
    </div>
  )
}
