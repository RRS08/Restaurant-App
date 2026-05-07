'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getAuthContext, formatError } from '@/lib/auth'

export async function createCategory(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const name = (formData.get('name') as string)?.trim()
  if (!name) return { error: 'Category name is required.' }

  const { error } = await ctx.supabase.from('menu_categories').insert({
    restaurant_id: ctx.restaurantId,
    name,
  })

  if (error) {
    console.error('Category creation failed:', error)
    return { error: formatError('category', error) }
  }

  revalidatePath('/menu')
  redirect('/menu')
}

// Creates an item directly inside a section (category_id required)
export async function createMenuItemInSection(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const name = (formData.get('name') as string)?.trim()
  const priceRaw = formData.get('price') as string
  const categoryId = formData.get('category_id') as string

  if (!name) return { error: 'Item name is required.' }
  if (!categoryId) return { error: 'Section is required.' }

  const price = parseFloat(priceRaw)
  if (isNaN(price) || price < 0) return { error: 'Please enter a valid price.' }

  const { error } = await ctx.supabase.from('menu_items').insert({
    restaurant_id: ctx.restaurantId,
    category_id: categoryId,
    name,
    current_price: price,
    source: 'manual',
    external_id: null,
  })

  if (error) {
    console.error('Menu item creation failed:', error)
    return { error: formatError('menu item', error) }
  }

  revalidatePath('/menu')
  return null // success — stay on the menu page
}

export async function createMenuItem(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const name = (formData.get('name') as string)?.trim()
  const priceRaw = formData.get('price') as string
  const categoryId = (formData.get('category_id') as string) || null

  if (!name) return { error: 'Item name is required.' }

  const price = parseFloat(priceRaw)
  if (isNaN(price) || price < 0) return { error: 'Please enter a valid price.' }

  const { error } = await ctx.supabase.from('menu_items').insert({
    restaurant_id: ctx.restaurantId,
    category_id: categoryId,
    name,
    current_price: price,
    source: 'manual',
    external_id: null,
  })

  if (error) {
    console.error('Menu item creation failed:', error)
    return { error: formatError('menu item', error) }
  }

  revalidatePath('/menu')
  redirect('/menu')
}

export async function deleteCategory(formData: FormData) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return

  const categoryId = formData.get('category_id') as string
  if (!categoryId) return

  // Items in this category get category_id set to null (on delete set null in schema)
  await ctx.supabase.from('menu_categories').delete().eq('id', categoryId)
  revalidatePath('/menu')
}

// Deletes a menu item. Recipe components are removed automatically
// (on delete cascade). If the item has order history (order_items
// references it with on delete restrict), the delete is blocked by
// PostgreSQL and we deactivate instead.
// Inventory items are NEVER affected — only the menu item and its
// recipe links are removed.
export async function deleteMenuItem(
  prevState: { error: string } | null,
  formData: FormData
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const itemId = formData.get('item_id') as string
  if (!itemId) return { error: 'No item specified.' }

  // Try delete — will fail if order_items references this item (restrict)
  const { error } = await ctx.supabase.from('menu_items').delete().eq('id', itemId)

  if (error) {
    // FK violation from order_items — deactivate instead
    if (error.code === '23503') {
      await ctx.supabase.from('menu_items').update({ active: false }).eq('id', itemId)
      revalidatePath('/menu')
      return { error: 'Item has order history and cannot be fully deleted. It has been deactivated instead.' }
    }
    return { error: error.message }
  }

  revalidatePath('/menu')
  return null
}
