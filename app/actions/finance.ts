'use server'

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, logAudit, formatError } from '@/lib/auth'
import { requireLocationAccess, AuthzError } from '@/lib/authz'
import { EXPENSE_CATEGORIES } from '@/lib/finance/constants'

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
  const vendorName = (formData.get('vendor_name') as string)?.trim() || null
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
  })

  if (error) {
    console.error('Expense creation failed:', error)
    return { error: formatError('expense', error) }
  }

  await logAudit(ctx, locationId, 'create_expense', 'expenses', undefined, { amount, category })
  revalidatePath('/finance')
  return null
}
