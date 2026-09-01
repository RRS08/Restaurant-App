import { createClient } from '@/lib/supabase/server'
import { isPlaidConfigured } from '@/lib/plaid/client'
import FinanceRefreshButton from './finance-refresh-button'

// ----------------------------------------------------------------
// FinanceSyncCard — settings-side refresh control for the Plaid
// pipeline. Plaid webhooks handle live tx as they land; the
// 30-min safety cron re-hits every item on a schedule. This
// button is the "impatient" path: right now, sync every connected
// item, materialize new movements into the ledger, and refresh
// live balances.
//
// Hidden entirely when Plaid isn't configured OR the operator has
// no connected items — nothing to refresh.
// ----------------------------------------------------------------

export default async function FinanceSyncCard({ restaurantId }: { restaurantId: string }) {
  if (!isPlaidConfigured()) return null
  const supabase = await createClient()
  const { data } = await supabase
    .from('bank_provider_secrets')
    .select('provider_item_id')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
  const itemCount = (data ?? []).length
  if (itemCount === 0) return null

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-900">Finance sync</h3>
        <p className="mt-1 text-xs text-gray-500">
          Plaid webhooks post new transactions as they land; a background job double-checks every 30 minutes.
          Use this only if something looks out of date.
        </p>
      </div>
      <FinanceRefreshButton itemCount={itemCount} />
    </div>
  )
}
