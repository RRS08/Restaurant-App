// ----------------------------------------------------------------
// Materialize raw bank_transactions → finance_movements.
//
// Runs after Plaid sync. Reads every unmaterialized
// bank_transactions row (idempotent via origin_ref =
// provider_transaction_id) inside the 90-day backfill window and:
//
//   1. Resolves the finance_account tile that mirrors each
//      bank account (by provider_ref = provider_account_id).
//   2. Maps Plaid's personal_finance_category → SEED_CATEGORIES
//      via lib/finance/plaid-category-map.ts.
//   3. Auto-pairs transfer legs across two of the user's own
//      linked accounts (same day, same amount, opposite direction,
//      transfer hint on at least one side).
//   4. Inserts finance_movements with origin='auto',
//      origin_ref=provider_transaction_id.
//
// Balance is NOT bumped from here — Plaid's live balance is the
// source of truth and is re-fetched separately on every sync so
// the tile never drifts from the bank.
//
// Backfill window: 90 days. bank_transactions keeps every row
// Plaid returns (raw truth); the operator-facing ledger mirrors
// the last quarter, matching the window the Transactions tab
// queries. "Pull more history" is a future affordance.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import { mapPlaidCategory } from './plaid-category-map'

// Ledger backfill window. Raised 30 → 90 so the operator-facing
// ledger covers the same 90 days the Finance → Transactions tab
// already queries; at 30 the tab asked for a quarter of history and
// could only ever be shown a month of it. bank_transactions still
// keeps everything Plaid returns — this only bounds what gets
// mirrored into finance_movements.
//
// Applies to every tenant, not just the one this was traced on.
const BACKFILL_DAYS = 90
const TRANSFER_MATCH_WINDOW_DAYS = 2

export interface MaterializeResult {
  inserted: number
  transfersPaired: number
  error: string | null
}

interface BankTxRow {
  id: string
  connected_bank_account_id: string
  provider_transaction_id: string
  amount: number | string
  direction: 'inflow' | 'outflow'
  description: string | null
  merchant_name: string | null
  raw_category: string | null
  posted_at: string
  pending: boolean
  provider_metadata: {
    personal_finance_category?: { primary?: string | null; detailed?: string | null } | null
    pending_transaction_id?: string | null
  } | null
}

interface CategoryRow {
  id: string
  name: string
  kind: 'income' | 'expense' | 'transfer'
}

interface AccountMapEntry {
  financeAccountId: string
  connectedBankAccountId: string
}

export async function materializeFinanceMovements(
  admin: SupabaseClient,
  restaurantId: string,
): Promise<MaterializeResult> {
  const cutoff = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // 1. Load raw tx within window.
  const { data: rawTx } = await admin
    .from('bank_transactions')
    .select('id, connected_bank_account_id, provider_transaction_id, amount, direction, description, merchant_name, raw_category, posted_at, pending, provider_metadata')
    .eq('restaurant_id', restaurantId)
    .gte('posted_at', cutoff)
    .order('posted_at', { ascending: true })
  if (!rawTx || rawTx.length === 0) return { inserted: 0, transfersPaired: 0, error: null }

  // 2. Pending → posted dedup pass.
  //    Plaid returns a NEW transaction_id when a pending row posts,
  //    and sets pending_transaction_id on the new row pointing to
  //    the original. If we've already materialized the pending
  //    version, wipe it now — the posted row will replace it.
  //    Also collect the pending IDs referenced so we don't
  //    re-materialize them below.
  const postedRefsThatReplace = new Map<string, string>()  // pending_id → posted_id
  for (const t of rawTx as BankTxRow[]) {
    const pending = t.provider_metadata?.pending_transaction_id
    if (pending) postedRefsThatReplace.set(pending, t.provider_transaction_id)
  }
  if (postedRefsThatReplace.size > 0) {
    await admin
      .from('finance_movements')
      .delete()
      .eq('restaurant_id', restaurantId)
      .eq('origin', 'auto')
      .in('origin_ref', Array.from(postedRefsThatReplace.keys()))
  }
  const supersededPendingIds = new Set(postedRefsThatReplace.keys())

  // 3. Load already-materialized origin refs so we skip them.
  const providerRefs = (rawTx as BankTxRow[]).map(t => t.provider_transaction_id)
  const { data: existing } = await admin
    .from('finance_movements')
    .select('origin_ref')
    .eq('restaurant_id', restaurantId)
    .eq('origin', 'auto')
    .in('origin_ref', providerRefs)
  const materialized = new Set(
    (existing ?? []).map(r => (r as { origin_ref: string | null }).origin_ref).filter((x): x is string => !!x)
  )
  const fresh = (rawTx as BankTxRow[]).filter(
    t => !materialized.has(t.provider_transaction_id) &&
         !supersededPendingIds.has(t.provider_transaction_id),
  )
  if (fresh.length === 0) return { inserted: 0, transfersPaired: 0, error: null }

  // 3. Build connected_bank_account → finance_account map.
  const { data: connectedRows } = await admin
    .from('connected_bank_accounts')
    .select('id, provider_account_id')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
  const cbaById = new Map<string, string>() // cba.id → provider_account_id
  for (const c of connectedRows ?? []) {
    cbaById.set((c as { id: string }).id, (c as { provider_account_id: string }).provider_account_id)
  }

  const { data: financeAccounts } = await admin
    .from('finance_accounts')
    .select('id, provider_ref')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .eq('active', true)
  const financeByProviderRef = new Map<string, string>()
  for (const f of financeAccounts ?? []) {
    const pr = (f as { provider_ref: string | null }).provider_ref
    if (pr) financeByProviderRef.set(pr, (f as { id: string }).id)
  }

  const accountMap = new Map<string, AccountMapEntry>() // cba.id → { financeAccountId, connectedBankAccountId }
  for (const [cbaId, providerAccountId] of cbaById.entries()) {
    const financeAccountId = financeByProviderRef.get(providerAccountId)
    if (financeAccountId) {
      accountMap.set(cbaId, { financeAccountId, connectedBankAccountId: cbaId })
    }
  }

  // 4. Load current categories so we can resolve seed names → ids.
  const { data: categories } = await admin
    .from('finance_categories')
    .select('id, name, kind')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
  const categoryByName = new Map<string, CategoryRow>()
  for (const c of (categories ?? []) as CategoryRow[]) {
    categoryByName.set(c.name.toLowerCase(), c)
  }

  // 5. Transfer pairing pass — group by day + amount, look for
  //    opposite-direction hits across two accounts.
  const transferHints: Set<string> = new Set() // provider_transaction_id
  interface PrepRow {
    raw: BankTxRow
    financeAccountId: string | null
    seedName: string | null
    isTransferHint: boolean
    dayKey: string
    amountNum: number
  }
  const prepped: PrepRow[] = fresh.map(t => {
    const acct = accountMap.get(t.connected_bank_account_id)
    const pfc = t.provider_metadata?.personal_finance_category ?? null
    const cat = mapPlaidCategory(pfc?.primary ?? null, pfc?.detailed ?? null)
    const amt = typeof t.amount === 'number' ? t.amount : parseFloat(String(t.amount))
    return {
      raw: t,
      financeAccountId: acct?.financeAccountId ?? null,
      seedName: cat.seedName,
      isTransferHint: cat.isTransferHint,
      dayKey: t.posted_at.slice(0, 10),
      amountNum: Number.isFinite(amt) ? amt : 0,
    }
  })
  // Drop non-positive amounts BEFORE pairing or insertion.
  //
  // finance_movements carries a check constraint (amount > 0) — a
  // movement is a signed quantity of money whose direction lives in
  // source/dest, so zero is meaningless there. Banks nonetheless
  // emit $0.00 informational rows: Rio Bank posts a monthly
  // "CREDIT CHARGE MCBI INST FREE BUSDC" fee-waiver memo at $0.00.
  //
  // This mattered far more than one skipped row suggests. The
  // insert below is a SINGLE batch, so Postgres rejected all of it
  // on the one bad row — Hatziri had 237 real bank_transactions and
  // exactly 0 finance_movements, and Finance read "Nothing has
  // moved yet" while the error stayed in a server log nobody was
  // watching. One $0.00 bank memo hid three months of ledger.
  const skippedNonPositive = prepped.length - prepped.filter(p => p.amountNum > 0).length
  const usable = prepped.filter(p => p.amountNum > 0)

  // Pair candidates: same amount, opposite direction, within a small
  // date window, both mapped to a finance account, at least one hinted.
  const pairs = new Map<string, string>() // provider_transaction_id (outflow) → provider_transaction_id (inflow)
  const usedInPair = new Set<string>()
  for (const outflow of usable) {
    if (outflow.raw.direction !== 'outflow') continue
    if (usedInPair.has(outflow.raw.provider_transaction_id)) continue
    if (!outflow.financeAccountId) continue
    const outDay = new Date(outflow.raw.posted_at).getTime()
    for (const inflow of usable) {
      if (inflow.raw.direction !== 'inflow') continue
      if (usedInPair.has(inflow.raw.provider_transaction_id)) continue
      if (!inflow.financeAccountId) continue
      if (inflow.financeAccountId === outflow.financeAccountId) continue
      if (Math.abs(inflow.amountNum - outflow.amountNum) > 0.01) continue
      const inDay = new Date(inflow.raw.posted_at).getTime()
      const daysApart = Math.abs(inDay - outDay) / (24 * 60 * 60 * 1000)
      if (daysApart > TRANSFER_MATCH_WINDOW_DAYS) continue
      if (!outflow.isTransferHint && !inflow.isTransferHint) continue
      pairs.set(outflow.raw.provider_transaction_id, inflow.raw.provider_transaction_id)
      usedInPair.add(outflow.raw.provider_transaction_id)
      usedInPair.add(inflow.raw.provider_transaction_id)
      transferHints.add(outflow.raw.provider_transaction_id)
      transferHints.add(inflow.raw.provider_transaction_id)
      break
    }
  }

  // 6. Build insert rows.
  //    - Paired transfers: emit ONE row (source=outflow account,
  //      dest=inflow account), suppress the inflow half.
  //    - Unpaired: emit an income (inflow) or expense (outflow) row.
  const emittedInflowsCoveredByPair = new Set<string>()
  for (const inflowId of pairs.values()) emittedInflowsCoveredByPair.add(inflowId)

  const insertRows: Array<Record<string, unknown>> = []

  for (const p of usable) {
    if (emittedInflowsCoveredByPair.has(p.raw.provider_transaction_id)) continue
    if (!p.financeAccountId) continue // no matching Finance tile — skip

    const paired = pairs.get(p.raw.provider_transaction_id)

    if (paired) {
      // Transfer row: source = this (outflow), dest = the paired inflow's account
      const inflowPrep = usable.find(x => x.raw.provider_transaction_id === paired)
      if (!inflowPrep?.financeAccountId) continue
      const cat = categoryByName.get('between accounts') ?? null
      insertRows.push({
        restaurant_id: restaurantId,
        occurred_at: p.raw.posted_at,
        amount: p.amountNum,
        source_account_id: p.financeAccountId,
        dest_account_id: inflowPrep.financeAccountId,
        category_id: cat?.id ?? null,
        note: cleanMerchant(p.raw.merchant_name || p.raw.description) || 'Transfer',
        memo: null,
        origin: 'auto',
        origin_ref: p.raw.provider_transaction_id,
      })
      continue
    }

    // Standalone income (inflow) or expense (outflow) — the row
    // is NOT a paired transfer. If the Plaid mapping suggested a
    // 'transfer'-kind seed (Between accounts, Card settlement,
    // etc.), we deliberately drop it here: Zelle to a person or
    // a card payment that doesn't have a matching internal leg
    // isn't a transfer, it's a real payment. Leave it Uncategorized
    // so the operator (or a future rules engine) can label it.
    const isInflow = p.raw.direction === 'inflow'
    const seed = p.seedName ? categoryByName.get(p.seedName.toLowerCase()) : null
    const kindOk =
      !seed ||
      (isInflow && seed.kind === 'income') ||
      (!isInflow && seed.kind === 'expense')
      // Note: seed.kind === 'transfer' intentionally NOT allowed
      // for standalone rows — we already checked for pairing above.
    insertRows.push({
      restaurant_id: restaurantId,
      occurred_at: p.raw.posted_at,
      amount: p.amountNum,
      source_account_id: isInflow ? null : p.financeAccountId,
      dest_account_id: isInflow ? p.financeAccountId : null,
      category_id: kindOk ? (seed?.id ?? null) : null,
      note: cleanMerchant(p.raw.merchant_name || p.raw.description) || (isInflow ? 'Deposit' : 'Charge'),
      memo: null,
      origin: 'auto',
      origin_ref: p.raw.provider_transaction_id,
    })
  }

  if (insertRows.length === 0) {
    if (skippedNonPositive > 0) {
      console.info('[finance:materialize] skipped non-positive rows', { skippedNonPositive })
    }
    return { inserted: 0, transfersPaired: pairs.size, error: null }
  }

  const { error } = await admin.from('finance_movements').insert(insertRows)
  if (!error) {
    if (skippedNonPositive > 0) {
      console.info('[finance:materialize] skipped non-positive rows', { skippedNonPositive })
    }
    return { inserted: insertRows.length, transfersPaired: pairs.size, error: null }
  }

  // Batch insert failed. Retry row by row so ONE malformed row can't
  // keep every good row out of the ledger.
  //
  // This is the failure mode that produced the bug above: a single
  // rejected row meant a customer's Finance tab read "Nothing has
  // moved yet" across three months of real activity. The $0.00 case
  // is now filtered upstream, but the batch is built from live bank
  // data we don't fully control, so degrade to partial success
  // instead of total failure and surface what was dropped.
  console.error('[finance:materialize] batch insert failed, falling back to per-row', error)
  let inserted = 0
  const failures: Array<{ origin_ref: unknown; message: string }> = []
  for (const row of insertRows) {
    const { error: rowError } = await admin.from('finance_movements').insert(row)
    if (rowError) {
      failures.push({ origin_ref: row.origin_ref, message: rowError.message })
    } else {
      inserted++
    }
  }
  if (failures.length > 0) {
    console.error('[finance:materialize] rows rejected individually', {
      rejected: failures.length,
      inserted,
      sample: failures.slice(0, 5),
    })
  }
  return {
    inserted,
    transfersPaired: pairs.size,
    // Only surface an error when NOTHING landed. A partial batch is
    // a real, useful result — the ledger is populated and the
    // rejected rows are named in the logs.
    error: inserted === 0 ? error.message : null,
  }
}

// ---------------------------------------------------------------- merchant cleanup

/** Turn a raw bank descriptor into a human-legible merchant name.
 *
 *  Bank feeds ship names like "STRIPE TRANSFER ST-C8G0E0F9A7R9 CCD
 *  ID: 4270465600" — the merchant is Stripe, the rest is ACH
 *  metadata. Cleaning at materialize time (rather than at render)
 *  keeps the ledger, report, and CSV export all consistent, and
 *  the Categorize UI (later) can key rules off a stable name.
 *
 *  Only handles the top payout/wallet providers explicitly —
 *  everything else keeps its original name, trimmed. Regex
 *  maintenance is deliberately bounded: a generic "always clean
 *  everything" approach chases its tail forever. */
const MERCHANT_PATTERNS: Array<[RegExp, string]> = [
  [/\bstripe\b.*(?:transfer|payout|ach)/i, 'Stripe payout'],
  [/\bstripe\b/i, 'Stripe'],
  [/\bsquare\s+(inc|payments|payout|transfer)/i, 'Square payout'],
  [/^sq\s*\*/i, 'Square'],
  [/\bshopify\b.*(?:transfer|payout|ach)/i, 'Shopify payout'],
  [/\bshopify\b/i, 'Shopify'],
  [/\bpaypal\b.*(?:transfer|payout|ach|inst\s*xfer)/i, 'PayPal payout'],
  [/\bpaypal\b/i, 'PayPal'],
  [/\bvenmo\b.*(?:cashout|transfer|payout)/i, 'Venmo cashout'],
  [/\bvenmo\b/i, 'Venmo'],
  [/\bcash\s*app\b/i, 'Cash App'],
  [/^amazon(\.com|\s+mktp|\s+mktplace)/i, 'Amazon'],
  [/^amzn\s*mktp/i, 'Amazon'],
  [/\bdoordash\b/i, 'DoorDash'],
  [/\buber\s+eats\b/i, 'Uber Eats'],
  [/^gdp\*/i, ''],  // GoDaddy Payments prefix — strip and keep the rest
]

/** Strip common trailing ACH / bank-descriptor junk before we
 *  hand a merchant name to the ledger. Chase, BofA, Wells all
 *  ship long descriptors with transaction ids, dates, and account
 *  abbreviations — human eyes skip over "transaction#: 30607813209
 *  08/31" to find the merchant, so we just remove it. */
function stripAchNoise(name: string): string {
  return name
    // NACHA ACH channel IDs — trailing ID metadata
    .replace(/\s+(CCD|PPD|WEB|TEL|ARC|BOC|POP)\s+ID:.*$/i, '')
    .replace(/\s+ID:\s*\d+.*$/i, '')
    // Chase transaction reference — "transaction#: 30607813209" or "trn: 12345"
    .replace(/\s+transaction\s*#?\s*:?\s*\d+.*$/i, '')
    .replace(/\s+trn\s*#?\s*:?\s*\d+.*$/i, '')
    // Stripe reference tail
    .replace(/\s+ST-[A-Z0-9]{6,}\b.*$/i, '')
    // Order / ref numbers (# followed by ≥6 alphanumeric)
    .replace(/\s+#\s*\w{6,}\b.*$/i, '')
    // Trailing MM/DD date banks tack onto transfer descriptors
    .replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Rewrite common bank-shorthand tokens INSIDE a descriptor so
 *  "Online Transfer to CHK ...3107" reads as "Transfer to Checking
 *  ··3107". Runs before the payout-provider whitelist because these
 *  are content-preserving edits, not full replacements. */
function rewriteBankTokens(name: string): string {
  return name
    // Chase-style leading "Online Transfer" → "Transfer"
    .replace(/^online\s+transfer\b/i, 'Transfer')
    // Account subtype abbreviations — word-bounded so we don't
    // mangle "checked" or a merchant name that happens to contain
    // "sav".
    .replace(/\bCHK\b/g, 'Checking')
    .replace(/\bSAV\b/g, 'Savings')
    .replace(/\bDDA\b/g, 'Checking')  // Demand Deposit Account
    .replace(/\bMMK?T?\b/g, 'Money market')
    // Mask style — turn "...NNNN" into our tile-matching "··NNNN"
    .replace(/\.{3,}(\d{3,})/g, '··$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function cleanMerchant(raw: string | null | undefined): string {
  if (!raw) return ''
  let name = rewriteBankTokens(String(raw).trim())
  if (!name) return ''

  // Explicit prefix strip (e.g. GDP*Hatziri Botanicals → Hatziri Botanicals)
  for (const [pattern, replacement] of MERCHANT_PATTERNS) {
    if (pattern.test(name)) {
      if (replacement === '') {
        name = name.replace(pattern, '').trim()
      } else {
        return replacement
      }
    }
  }

  return stripAchNoise(name)
}
