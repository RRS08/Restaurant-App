'use server'

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, logAudit, formatError } from '@/lib/auth'
import { requireLocationAccess, AuthzError } from '@/lib/authz'
import { EXPENSE_CATEGORIES } from '@/lib/finance/constants'
import { normalizeDisplayName } from '@/lib/strings/names'

async function requireLocResult(restaurantId: string, locationId: string): Promise<string | null> {
  try {
    await requireLocationAccess(restaurantId, locationId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

export async function createExpense(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const formLocationId = formData.get('location_id') as string
  const { locationId, error: locError } = await resolveLocationId(ctx, formLocationId)
  if (locError) return { error: locError }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const category = formData.get('category') as string
  const amountRaw = formData.get('amount') as string
  const expenseDate = formData.get('expense_date') as string
  // Vendor name is a short user-created business identifier →
  // normalize display form so "us foods", "US FOODS", and "Us Foods"
  // resolve to one clean stored value. No dedup (no vendor entity).
  // Notes are free-text and stay raw.
  const vendorRaw = (formData.get('vendor_name') as string)?.trim() || ''
  const vendorName = vendorRaw ? normalizeDisplayName(vendorRaw) : null
  const notes = (formData.get('notes') as string)?.trim() || null
  const isInventoryRelated = formData.get('is_inventory_related') === 'on'

  if (!EXPENSE_CATEGORIES.includes(category as typeof EXPENSE_CATEGORIES[number])) {
    return { error: 'Please select a valid category.' }
  }

  const amount = parseFloat(amountRaw)
  if (isNaN(amount) || amount <= 0) return { error: 'Amount must be greater than 0.' }
  if (!expenseDate) return { error: 'Expense date is required.' }

  const { error } = await ctx.supabase.from('expenses').insert({
    restaurant_id: ctx.restaurantId,
    location_id: locationId,
    category,
    amount,
    expense_date: expenseDate,
    vendor_name: vendorName,
    notes,
    is_inventory_related: isInventoryRelated,
    // Multi-source expense model. Manual entries flag explicitly so
    // future origins (inventory_purchase / bank_mapped / etc.) can
    // be distinguished without inferring from other fields.
    source: 'manual',
  })

  if (error) {
    console.error('Expense creation failed:', error)
    return { error: formatError('expense', error) }
  }

  await logAudit(ctx, locationId, 'create_expense', 'expenses', undefined, { amount, category })
  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return null
}

// ----------------------------------------------------------------
// updateExpenseCategory — inline categorize-on-tap for the Finance
// dashboard ledger. Takes an expense id + a new category name;
// verifies the caller has access to the expense's location; writes
// the change; revalidates. Deliberately narrow so the "one tap to
// recategorize" affordance can't be turned into a full edit surface
// by accident — amount, vendor, date, notes are untouched.
// ----------------------------------------------------------------
export async function updateExpenseCategory(
  expenseId: string,
  category: string
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  if (!EXPENSE_CATEGORIES.includes(category as typeof EXPENSE_CATEGORIES[number])) {
    return { error: 'Please select a valid category.' }
  }

  // Ensure the expense belongs to the caller's restaurant, and pull
  // the location id so we can verify location access. RLS also gates
  // this; the check here is defense-in-depth + friendly error.
  const { data: existing } = await ctx.supabase
    .from('expenses')
    .select('id, location_id')
    .eq('id', expenseId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!existing) return { error: 'Expense not found.' }

  const locAuthErr = await requireLocResult(ctx.restaurantId, existing.location_id as string)
  if (locAuthErr) return { error: locAuthErr }

  const { error } = await ctx.supabase
    .from('expenses')
    .update({ category })
    .eq('id', expenseId)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('expense', error) }

  await logAudit(ctx, existing.location_id as string, 'update_expense_category', 'expenses', expenseId, { category })
  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return null
}
