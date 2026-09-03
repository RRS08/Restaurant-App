// ----------------------------------------------------------------
// Plaid Personal Finance Category → SEED_CATEGORIES mapping.
//
// Plaid returns two taxonomy fields on every transaction:
//   personal_finance_category.primary  — coarse (~15 buckets)
//   personal_finance_category.detailed — fine (~100 buckets)
//
// We map primary buckets to our seed categories. When Plaid's
// detailed says "TRANSFER_IN" / "TRANSFER_OUT" / "LOAN_PAYMENTS",
// we surface a transfer signal so the materialize pass can pair
// two legs of the same movement across accounts and hide them from
// the P&L view.
//
// Categories the operator has renamed OR new ones they've added
// aren't affected — we resolve by canonical seed name, and the
// materialize step just looks up whatever id matches now. If the
// operator deleted a seed row, the tx lands Uncategorized (id
// null) and shows up in the Review queue.
// ----------------------------------------------------------------

export type PlaidPrimaryCategory =
  | 'INCOME'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'LOAN_PAYMENTS'
  | 'LOAN_DISBURSEMENTS'
  | 'BANK_FEES'
  | 'ENTERTAINMENT'
  | 'FOOD_AND_DRINK'
  | 'GENERAL_MERCHANDISE'
  | 'HOME_IMPROVEMENT'
  | 'MEDICAL'
  | 'PERSONAL_CARE'
  | 'GENERAL_SERVICES'
  | 'GOVERNMENT_AND_NON_PROFIT'
  | 'TRANSPORTATION'
  | 'TRAVEL'
  | 'RENT_AND_UTILITIES'

/** Result of mapping a Plaid tx.
 *   - seedName: which SEED_CATEGORIES row to attach (by canonical
 *     name), or null if we can't confidently pick one.
 *   - isTransferHint: true when Plaid says this is a transfer/loan
 *     leg. Materialize uses this to try to pair it with a matching
 *     opposite-direction tx on another linked account. */
export interface PlaidCategoryMapResult {
  seedName: string | null
  isTransferHint: boolean
  /** 'high' = auto-apply confidently. 'low' = attach but flag for
   *  review. 'none' = leave uncategorized. */
  confidence: 'high' | 'low' | 'none'
}

const PRIMARY_MAP: Record<PlaidPrimaryCategory, PlaidCategoryMapResult> = {
  INCOME:                   { seedName: 'Sales',      isTransferHint: false, confidence: 'high' },
  TRANSFER_IN:              { seedName: 'Between accounts', isTransferHint: true, confidence: 'high' },
  TRANSFER_OUT:             { seedName: 'Between accounts', isTransferHint: true, confidence: 'high' },
  LOAN_PAYMENTS:            { seedName: 'Other',      isTransferHint: true, confidence: 'low' },
  // Loan/financing money ARRIVING. Borrowed principal is not
  // revenue — it is a balance-sheet event that has to be paid back.
  // This bucket was missing entirely, so a $25,000 WebBank/Reprise
  // disbursement fell through to seedName null, landed
  // Uncategorized, and was summed as income: 84% of Hatziri's
  // reported 30-day "revenue" was a loan.
  //
  // 'Financing' is transfer-kind, so isOperational() keeps it out
  // of BOTH the income and the spend totals while it stays visible
  // in the ledger.
  LOAN_DISBURSEMENTS:       { seedName: 'Financing',  isTransferHint: false, confidence: 'high' },
  BANK_FEES:                { seedName: 'Fees',       isTransferHint: false, confidence: 'high' },
  RENT_AND_UTILITIES:       { seedName: 'Utilities',  isTransferHint: false, confidence: 'low' },
  GOVERNMENT_AND_NON_PROFIT:{ seedName: 'Other',      isTransferHint: false, confidence: 'low' },
  GENERAL_SERVICES:         { seedName: 'Other',      isTransferHint: false, confidence: 'low' },
  GENERAL_MERCHANDISE:      { seedName: 'Supplies',   isTransferHint: false, confidence: 'low' },
  HOME_IMPROVEMENT:         { seedName: 'Supplies',   isTransferHint: false, confidence: 'low' },
  FOOD_AND_DRINK:           { seedName: 'Inventory',  isTransferHint: false, confidence: 'low' },
  TRAVEL:                   { seedName: 'Other',      isTransferHint: false, confidence: 'low' },
  TRANSPORTATION:           { seedName: 'Other',      isTransferHint: false, confidence: 'low' },
  ENTERTAINMENT:            { seedName: 'Other',      isTransferHint: false, confidence: 'low' },
  MEDICAL:                  { seedName: 'Other',      isTransferHint: false, confidence: 'low' },
  PERSONAL_CARE:            { seedName: 'Other',      isTransferHint: false, confidence: 'low' },
}

/** Special-case detailed overrides. Higher priority than primary
 *  when present — e.g. detailed "RENT" resolves confidently to
 *  the "Rent" seed, even though the primary is RENT_AND_UTILITIES. */
const DETAILED_OVERRIDES: Record<string, PlaidCategoryMapResult> = {
  'RENT_AND_UTILITIES_RENT':                          { seedName: 'Rent',       isTransferHint: false, confidence: 'high' },
  'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY':           { seedName: 'Utilities',  isTransferHint: false, confidence: 'high' },
  'RENT_AND_UTILITIES_WATER':                         { seedName: 'Utilities',  isTransferHint: false, confidence: 'high' },
  'RENT_AND_UTILITIES_INTERNET_AND_CABLE':            { seedName: 'Utilities',  isTransferHint: false, confidence: 'high' },
  'RENT_AND_UTILITIES_TELEPHONE':                     { seedName: 'Utilities',  isTransferHint: false, confidence: 'high' },
  'GENERAL_SERVICES_ADVERTISING_AND_MARKETING':       { seedName: 'Marketing',  isTransferHint: false, confidence: 'high' },
  'INCOME_WAGES':                                     { seedName: 'Sales',      isTransferHint: false, confidence: 'high' },
  'INCOME_TAX_REFUND':                                { seedName: 'Refund in',  isTransferHint: false, confidence: 'high' },
  'INCOME_DIVIDENDS':                                 { seedName: 'Rental',     isTransferHint: false, confidence: 'low' },
  'INCOME_INTEREST_EARNED':                           { seedName: 'Rental',     isTransferHint: false, confidence: 'low' },
  'INCOME_RETIREMENT_PENSION':                        { seedName: 'Rental',     isTransferHint: false, confidence: 'low' },
  'INCOME_UNEMPLOYMENT':                              { seedName: 'Refund in',  isTransferHint: false, confidence: 'low' },
  'INCOME_OTHER_INCOME':                              { seedName: 'Rental',     isTransferHint: false, confidence: 'low' },
  'FOOD_AND_DRINK_GROCERIES':                         { seedName: 'Inventory',  isTransferHint: false, confidence: 'high' },
  'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT':                { seedName: 'Between accounts', isTransferHint: true, confidence: 'high' },
  'LOAN_PAYMENTS_MORTGAGE_PAYMENT':                   { seedName: 'Rent',       isTransferHint: false, confidence: 'high' },
  'BANK_FEES_INTEREST_CHARGE':                        { seedName: 'Fees',       isTransferHint: false, confidence: 'high' },
  'BANK_FEES_ATM_FEES':                               { seedName: 'Fees',       isTransferHint: false, confidence: 'high' },
  'BANK_FEES_OVERDRAFT_FEES':                         { seedName: 'Fees',       isTransferHint: false, confidence: 'high' },
  'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING': { seedName: 'Fees',     isTransferHint: false, confidence: 'high' },
  // Cash pulled out of a business account at an ATM is a draw, not
  // an operating expense. Hatziri had six months of these landing
  // Uncategorized and being summed against profit. Transfer-kind,
  // so isOperational() keeps them out of the P&L while they stay
  // visible in the ledger.
  //
  // Not universally true — some operators pull cash to stock a
  // register, which is 'Between accounts'. Owner draw is the safer
  // default: it errs toward NOT deducting something personal, and
  // the operator can recategorize. The reverse error (deducting a
  // personal withdrawal as a business expense) is the one with
  // consequences.
  'TRANSFER_OUT_WITHDRAWAL':                          { seedName: 'Owner draw', isTransferHint: false, confidence: 'low' },
  // Furniture, shelving, fixtures. Capitalized, not expensed.
  'HOME_IMPROVEMENT_FURNITURE':                       { seedName: 'Equipment',  isTransferHint: false, confidence: 'low' },
  'GENERAL_MERCHANDISE_OFFICE_SUPPLIES':              { seedName: 'Supplies',   isTransferHint: false, confidence: 'high' },
}

export function mapPlaidCategory(
  primary: string | null | undefined,
  detailed: string | null | undefined,
): PlaidCategoryMapResult {
  if (detailed && DETAILED_OVERRIDES[detailed]) return DETAILED_OVERRIDES[detailed]
  if (primary && (PRIMARY_MAP as Record<string, PlaidCategoryMapResult>)[primary]) {
    return (PRIMARY_MAP as Record<string, PlaidCategoryMapResult>)[primary]
  }
  return { seedName: null, isTransferHint: false, confidence: 'none' }
}
