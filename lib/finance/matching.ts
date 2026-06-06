// ----------------------------------------------------------------
// Finance Bank Review — V1 matching rules
//
// Pure, deterministic, in-process classifier that suggests a
// settlement kind for a single unreviewed bank transaction. No
// external API calls, no ML, no fuzzy matching — just two signals
// combined honestly:
//
//   1. Merchant / description keyword hit against a hand-curated
//      vendor list (Sysco, ADP, Stripe, etc.).
//   2. Plaid Personal Finance Category (PFC) primary hint.
//
// When both signals agree, the suggestion is a "likely match".
// When only one fires, it's a "candidate". When neither lands, the
// row stays "unclear" and the manager decides. The suggestion is a
// hint — the user always has the final say.
// ----------------------------------------------------------------

export type SuggestedKind = 'revenue' | 'inventory' | 'labor' | 'operating' | null
export type MatchConfidence = 'likely_match' | 'candidate' | 'unclear'

export interface BankTxnForMatch {
  direction: 'inflow' | 'outflow'
  amount: number
  rawCategory: string | null
  merchantName: string | null
  description: string | null
}

// Keyword lists. Each is checked case-insensitively against the
// concatenated merchant_name + description haystack. Lists are
// intentionally short and US-restaurant-leaning — they're tuned
// for the pilot, not for global coverage.
const REVENUE_KEYWORDS = [
  'stripe', 'square', 'toast', 'clover', 'shopify', 'payout',
  'merchant services', 'card sales', 'processor', 'paypal', 'venmo',
  'cash app', 'card deposit',
]

const INVENTORY_KEYWORDS = [
  'sysco', 'us foods', 'usfoods', 'restaurant depot',
  'heb', 'h-e-b', 'costco', "sam's club", 'sams club',
  'walmart', 'kroger', 'whole foods', 'gordon food',
  'food service', 'produce', 'meat market', 'seafood',
  'beverage distributor',
]

const LABOR_KEYWORDS = [
  'adp', 'gusto', 'paychex', 'square payroll', 'payroll',
  'wages', 'salary',
]

const OPERATING_KEYWORDS = [
  // Rent / utilities
  'rent', 'lease', 'electric', 'utility', 'utilities',
  'water bill', 'gas company', 'internet', 'comcast', 'spectrum',
  'at&t', 'verizon',
  // Marketing
  'google ads', 'facebook ads', 'meta ads', 'marketing',
  'advertis',
  // Subscriptions / SaaS
  'subscription', 'saas', 'software',
  // Insurance
  'insurance',
  // Bank fees
  'overdraft', 'monthly fee', 'service fee', 'bank fee',
  // Loans / financing
  'loan payment', 'lender',
]

// Personal-looking keywords for the "ignore candidate" path.
// Surfaced separately so the UI can flag "looks personal" without
// auto-ignoring — the manager always confirms.
const PERSONAL_KEYWORDS = [
  'medical', 'doctor', 'pharmacy', 'hospital', 'clinic',
  'personal care', 'salon', 'gym',
  'restaurant ', 'starbucks', 'mcdonald', 'chipotle',
  'amazon prime', 'netflix', 'hulu', 'spotify',
]

function hasKeyword(haystack: string, keywords: string[]): boolean {
  const lower = haystack.toLowerCase()
  return keywords.some((kw) => lower.includes(kw))
}

// PFC primary → preferred settlement kind. Conservative — only the
// PFCs that map cleanly are returned; ambiguous ones (TRANSPORTATION,
// TRAVEL, etc.) yield null so the merchant keyword check can drive.
function pfcKind(rawCategory: string | null, direction: 'inflow' | 'outflow'): SuggestedKind {
  if (!rawCategory) return null
  if (direction === 'inflow') {
    if (rawCategory === 'INCOME') return 'revenue'
    if (rawCategory === 'TRANSFER_IN') return 'revenue'
    return null
  }
  switch (rawCategory) {
    case 'FOOD_AND_DRINK':
    case 'GENERAL_MERCHANDISE':
      return 'inventory'
    case 'RENT_AND_UTILITIES':
    case 'GENERAL_SERVICES':
    case 'ENTERTAINMENT':
    case 'BANK_FEES':
    case 'LOAN_PAYMENTS':
      return 'operating'
    default:
      return null
  }
}

function haystackOf(txn: BankTxnForMatch): string {
  return `${txn.merchantName ?? ''} ${txn.description ?? ''}`
}

// Single suggested kind for the row. Merchant keywords win when
// both signals fire — manager intent is clearer when a known vendor
// is named.
export function suggestSettlementKind(txn: BankTxnForMatch): SuggestedKind {
  const haystack = haystackOf(txn)

  if (txn.direction === 'inflow') {
    if (hasKeyword(haystack, REVENUE_KEYWORDS)) return 'revenue'
    return pfcKind(txn.rawCategory, txn.direction)
  }

  if (hasKeyword(haystack, LABOR_KEYWORDS)) return 'labor'
  if (hasKeyword(haystack, INVENTORY_KEYWORDS)) return 'inventory'
  if (hasKeyword(haystack, OPERATING_KEYWORDS)) return 'operating'
  return pfcKind(txn.rawCategory, txn.direction)
}

// Confidence tier — feeds the "Suggested matches" section of the
// drawer (likely_match) vs the per-direction queues (candidate and
// unclear).
export function classifyConfidence(txn: BankTxnForMatch): MatchConfidence {
  const haystack = haystackOf(txn)

  if (txn.direction === 'inflow') {
    const hasRev = hasKeyword(haystack, REVENUE_KEYWORDS)
    const pfcHit = pfcKind(txn.rawCategory, txn.direction) === 'revenue'
    if (hasRev && pfcHit) return 'likely_match'
    if (hasRev || pfcHit) return 'candidate'
    return 'unclear'
  }

  const keywordHit =
    hasKeyword(haystack, INVENTORY_KEYWORDS) ||
    hasKeyword(haystack, LABOR_KEYWORDS) ||
    hasKeyword(haystack, OPERATING_KEYWORDS)
  const pfcHit = pfcKind(txn.rawCategory, txn.direction) !== null
  if (keywordHit && pfcHit) return 'likely_match'
  if (keywordHit || pfcHit) return 'candidate'
  return 'unclear'
}

// Surfaces "looks personal" — used by the drawer to nudge the
// manager toward Ignore for outflows that match the personal list.
export function looksPersonal(txn: BankTxnForMatch): boolean {
  if (txn.direction !== 'outflow') return false
  return hasKeyword(haystackOf(txn), PERSONAL_KEYWORDS)
}

// ================================================================
// Bank Review — group bucketing
//
// Maps a single transaction to a *group* (Costco, HEB, Rent &
// utilities, etc.) so the Bank Review surface can present one row
// per pattern instead of one row per transaction. Each group
// carries the suggested settlement, confidence, and the cue that
// drove the decision, so the UI can render
//
//   <name>
//   <count> transactions · <total>
//   Suggested: <category>
//   <reason>
//
// without re-running the classifier per render.
//
// The bucketer is purely keyword + PFC based — same primitives the
// per-row matcher already uses. Specific vendor labels come first
// (Costco buys its own group even when the category would have
// bucketed it), then category buckets, then a fallback "review"
// bucket for low-confidence rows. Direction-aware throughout: an
// inflow never ends up under "Rent & utilities".
// ================================================================

export type GroupKind = SuggestedKind | 'review' | 'personal'

// Triage tier — controls which drawer section a group lands in
// and whether it counts toward the "X need attention" headline.
//
//   attention : the manager should look at this. Examples — every
//               inflow (deposits/income always matter); outflows
//               with no confidence; transfers out; unusually large
//               unclear outflows.
//   personal  : a separate sub-tier of attention. Looks personal,
//               primary CTA is Mark personal, but it's still
//               surfaced.
//   auto      : auto-classified — visible but not required work.
//               Known vendor + clear category + amount within
//               normal range. Manager can override later.
export type GroupTriage = 'attention' | 'personal' | 'auto'

export interface GroupAssignment {
  key: string
  label: string
  suggestedKind: SuggestedKind
  confidence: MatchConfidence
  reason: string
  // When true, the group's primary CTA is "Mark personal" rather
  // than a confirm action — used for the "looks personal" bucket
  // so the manager isn't nudged to file personal spend as business.
  personal: boolean
}

// Specific vendor labels — when a transaction's haystack hits one
// of these patterns, the group label is the vendor name itself
// (Costco gets its own card; "Possible inventory vendors" only
// catches generic inventory keyword hits with no recognized brand).
// Kept short and deliberate — the goal is to surface high-signal
// recurring vendors, not to cover every grocery store.
const VENDOR_CATALOG: Array<{ test: RegExp; label: string; kind: SuggestedKind; reason: string }> = [
  // Inventory vendors (outflow)
  { test: /costco/i,                                    label: 'Costco',            kind: 'inventory', reason: 'known wholesale vendor' },
  { test: /\bh[\s-]?e[\s-]?b\b|heb /i,                  label: 'HEB',               kind: 'inventory', reason: 'grocery / food supplier pattern' },
  { test: /walmart/i,                                   label: 'Walmart',           kind: 'inventory', reason: 'general merchandise vendor' },
  { test: /sam'?s club|sams club/i,                     label: "Sam's Club",        kind: 'inventory', reason: 'wholesale vendor' },
  { test: /sysco/i,                                     label: 'Sysco',             kind: 'inventory', reason: 'food distributor' },
  { test: /us foods|usfoods/i,                          label: 'US Foods',          kind: 'inventory', reason: 'food distributor' },
  { test: /restaurant depot/i,                          label: 'Restaurant Depot',  kind: 'inventory', reason: 'restaurant supply vendor' },
  { test: /kroger/i,                                    label: 'Kroger',            kind: 'inventory', reason: 'grocery vendor' },
  { test: /whole foods/i,                               label: 'Whole Foods',       kind: 'inventory', reason: 'grocery vendor' },
  { test: /gordon food/i,                               label: 'Gordon Food',       kind: 'inventory', reason: 'food distributor' },
  // Payroll providers (outflow)
  { test: /\badp\b/i,                                   label: 'ADP Payroll',       kind: 'labor',     reason: 'payroll provider' },
  { test: /gusto/i,                                     label: 'Gusto Payroll',     kind: 'labor',     reason: 'payroll provider' },
  { test: /paychex/i,                                   label: 'Paychex Payroll',   kind: 'labor',     reason: 'payroll provider' },
  { test: /square payroll/i,                            label: 'Square Payroll',    kind: 'labor',     reason: 'payroll provider' },
  // Card / processor deposits (inflow)
  { test: /stripe/i,                                    label: 'Stripe deposits',   kind: 'revenue',   reason: 'incoming processor deposit' },
  { test: /\bsquare\b/i,                                label: 'Square deposits',   kind: 'revenue',   reason: 'incoming processor deposit' },
  { test: /toast/i,                                     label: 'Toast deposits',    kind: 'revenue',   reason: 'incoming processor deposit' },
  { test: /clover/i,                                    label: 'Clover deposits',   kind: 'revenue',   reason: 'incoming processor deposit' },
  { test: /shopify/i,                                   label: 'Shopify deposits',  kind: 'revenue',   reason: 'incoming processor deposit' },
  { test: /paypal/i,                                    label: 'PayPal',            kind: 'revenue',   reason: 'incoming processor deposit' },
  { test: /venmo/i,                                     label: 'Venmo',             kind: 'revenue',   reason: 'incoming processor deposit' },
  { test: /cash app/i,                                  label: 'Cash App',          kind: 'revenue',   reason: 'incoming processor deposit' },
]

function categoryBucket(txn: BankTxnForMatch): GroupAssignment | null {
  const haystack = haystackOf(txn).toLowerCase()
  const pfc = txn.rawCategory

  if (txn.direction === 'inflow') {
    if (/cash deposit/.test(haystack)) {
      return { key: 'cash_deposits', label: 'Cash deposits', suggestedKind: 'revenue', confidence: 'candidate', reason: 'incoming cash deposit', personal: false }
    }
    if (pfc === 'INCOME' || pfc === 'TRANSFER_IN') {
      return { key: 'other_income', label: 'Other income', suggestedKind: 'revenue', confidence: 'candidate', reason: 'classified as income', personal: false }
    }
    return null
  }

  // Outflow — personal first so it captures medical/etc. before
  // any operating-keyword hit (medical co-pays often look like
  // generic services).
  if (looksPersonal(txn)) {
    return { key: 'personal', label: 'Personal / likely non-business', suggestedKind: null, confidence: 'candidate', reason: 'looks personal — likely ignore', personal: true }
  }
  if (/rent|lease|electric|water bill|gas company|internet|comcast|spectrum|at&t|verizon|utility|utilities/.test(haystack) || pfc === 'RENT_AND_UTILITIES') {
    return { key: 'rent_utilities', label: 'Rent & utilities', suggestedKind: 'operating', confidence: 'likely_match', reason: 'recurring rent / utility pattern', personal: false }
  }
  if (/overdraft|monthly fee|service fee|bank fee/.test(haystack) || pfc === 'BANK_FEES') {
    return { key: 'bank_fees', label: 'Bank fees', suggestedKind: 'operating', confidence: 'likely_match', reason: 'bank fee pattern', personal: false }
  }
  if (/subscription|saas|software|google ads|facebook ads|meta ads|advertis|marketing|insurance/.test(haystack) || pfc === 'GENERAL_SERVICES') {
    return { key: 'services_subs', label: 'Services & subscriptions', suggestedKind: 'operating', confidence: 'candidate', reason: 'recurring services / subscription pattern', personal: false }
  }
  if (/transfer/.test(haystack) || pfc === 'TRANSFER_OUT') {
    return { key: 'transfers_out', label: 'Transfers out', suggestedKind: null, confidence: 'unclear', reason: 'looks like a transfer — needs review', personal: false }
  }
  if (hasKeyword(haystack, INVENTORY_KEYWORDS)) {
    return { key: 'possible_inventory', label: 'Possible inventory vendors', suggestedKind: 'inventory', confidence: 'candidate', reason: 'grocery / merchandise keyword' , personal: false }
  }
  if (hasKeyword(haystack, LABOR_KEYWORDS)) {
    return { key: 'possible_payroll', label: 'Possible labor / payroll', suggestedKind: 'labor', confidence: 'candidate', reason: 'payroll-like keyword', personal: false }
  }
  return null
}

export function bucketBankTxn(txn: BankTxnForMatch): GroupAssignment {
  const haystack = haystackOf(txn)

  // 1. Specific vendor groups — Costco, HEB, ADP, Stripe, etc.
  for (const v of VENDOR_CATALOG) {
    if (v.test.test(haystack)) {
      // Direction sanity check: a vendor whose canonical kind is
      // revenue (Stripe) only owns its own group on inflows. On an
      // outflow, fall through so categoryBucket / fallback can
      // bucket it sensibly.
      if (v.kind === 'revenue' && txn.direction !== 'inflow') continue
      if ((v.kind === 'inventory' || v.kind === 'labor') && txn.direction !== 'outflow') continue
      return {
        key: `vendor:${v.label.toLowerCase()}`,
        label: v.label,
        suggestedKind: v.kind,
        confidence: classifyConfidence(txn),
        reason: v.reason,
        personal: false,
      }
    }
  }

  // 2. Category buckets (Rent & utilities, Bank fees, etc.)
  const cat = categoryBucket(txn)
  if (cat) return cat

  // 3. Fallback — low-confidence; primary CTA becomes "Review details".
  if (txn.direction === 'inflow') {
    return { key: 'unmatched_in', label: 'Unmatched income', suggestedKind: null, confidence: 'unclear', reason: 'not enough confidence — review details', personal: false }
  }
  return { key: 'unknown_out', label: 'Unknown outflow', suggestedKind: null, confidence: 'unclear', reason: 'not enough confidence — review details', personal: false }
}

// ----------------------------------------------------------------
// Group aggregation
//
// Given an array of unreviewed bank transactions, group them by
// bucketBankTxn(...) key and sum count + total amount per group.
// Returns groups sorted by absolute total amount descending so the
// most material patterns surface first.
// ----------------------------------------------------------------
export interface GroupableTxn extends BankTxnForMatch {
  id: string
  postedAt: string
}

export interface BankReviewGroup {
  key: string
  label: string
  direction: 'inflow' | 'outflow'
  suggestedKind: SuggestedKind
  confidence: MatchConfidence
  reason: string
  personal: boolean
  /** assigned at aggregation time — see assignGroupTriage(). */
  triage: GroupTriage
  txnIds: string[]
  txnCount: number
  totalAmount: number
  txns: GroupableTxn[]
}

// Outflow groups above this total (USD, 7-day window) escalate
// out of auto-classification regardless of confidence — managers
// generally want eyes on unusually large movements even when the
// vendor pattern is familiar. Per-group, not per-txn, so a string
// of small recurring charges still auto-classifies.
const LARGE_OUTFLOW_ATTENTION_THRESHOLD = 2000

// "Group key" identifiers that should ALWAYS need attention even
// when the suggestion is non-null. Both fall into the "we don't
// really know what this is" tier — surfacing them is the safe
// default.
const ALWAYS_ATTENTION_KEYS = new Set(['transfers_out', 'unknown_out', 'unmatched_in'])

function assignGroupTriage(group: {
  direction: 'inflow' | 'outflow'
  suggestedKind: SuggestedKind
  confidence: MatchConfidence
  totalAmount: number
  personal: boolean
  /** the raw assignment.key BEFORE the direction prefix. */
  bareKey: string
}): GroupTriage {
  if (group.personal) return 'personal'
  // Every inflow gets attention. Incoming money is exactly what
  // owners care about most — sales deposits, cash deposits,
  // refunds, processor payouts. The matcher's suggestion is a
  // *hint*, not an auto-decision.
  if (group.direction === 'inflow') return 'attention'
  if (ALWAYS_ATTENTION_KEYS.has(group.bareKey)) return 'attention'
  if (group.suggestedKind === null) return 'attention'
  if (group.confidence === 'unclear') return 'attention'
  // Outflows + known vendor / category, but unusually large
  // → escalate so the manager sees them anyway.
  if (group.totalAmount > LARGE_OUTFLOW_ATTENTION_THRESHOLD && group.confidence !== 'likely_match') {
    return 'attention'
  }
  return 'auto'
}

export function groupBankTransactions(rows: GroupableTxn[]): BankReviewGroup[] {
  // Aggregate first — triage is computed afterwards because it
  // depends on the group's total amount, not per-row signals.
  const accum = new Map<string, {
    bareKey: string
    label: string
    direction: 'inflow' | 'outflow'
    suggestedKind: SuggestedKind
    confidence: MatchConfidence
    reason: string
    personal: boolean
    txnIds: string[]
    txnCount: number
    totalAmount: number
    txns: GroupableTxn[]
  }>()
  for (const row of rows) {
    const assignment = bucketBankTxn(row)
    // Same label can apply to both directions (a Walmart inflow
    // and Walmart outflow would otherwise collide). Include
    // direction in the key so groups never mix money-in + money-out.
    const key = `${row.direction}:${assignment.key}`
    const existing = accum.get(key)
    if (existing) {
      existing.txnIds.push(row.id)
      existing.txns.push(row)
      existing.txnCount += 1
      existing.totalAmount += row.amount
    } else {
      accum.set(key, {
        bareKey: assignment.key,
        label: assignment.label,
        direction: row.direction,
        suggestedKind: assignment.suggestedKind,
        confidence: assignment.confidence,
        reason: assignment.reason,
        personal: assignment.personal,
        txnIds: [row.id],
        txnCount: 1,
        totalAmount: row.amount,
        txns: [row],
      })
    }
  }

  const groups: BankReviewGroup[] = []
  for (const [key, g] of accum.entries()) {
    g.txns.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    groups.push({
      key,
      label: g.label,
      direction: g.direction,
      suggestedKind: g.suggestedKind,
      confidence: g.confidence,
      reason: g.reason,
      personal: g.personal,
      triage: assignGroupTriage({
        direction: g.direction,
        suggestedKind: g.suggestedKind,
        confidence: g.confidence,
        totalAmount: g.totalAmount,
        personal: g.personal,
        bareKey: g.bareKey,
      }),
      txnIds: g.txnIds,
      txnCount: g.txnCount,
      totalAmount: g.totalAmount,
      txns: g.txns,
    })
  }
  return groups.sort((a, b) => b.totalAmount - a.totalAmount)
}
