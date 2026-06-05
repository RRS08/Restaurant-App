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
