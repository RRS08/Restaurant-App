'use server'

// ----------------------------------------------------------------
// Inventory Cleanup + Integrity Checks
//
// Two main functions:
//   1. cleanupDuplicateInventoryItems — merge duplicates
//   2. runInventoryIntegrityChecks — detect issues
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { getAuthContext } from '@/lib/auth'

// ================================================================
// DUPLICATE MERGE
// ================================================================

export async function cleanupDuplicateInventoryItems() {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.', merged: 0 }

  const { supabase, restaurantId } = ctx

  // Fetch ALL inventory items (including inactive) to catch all duplicates
  const { data: allItems } = await supabase
    .from('inventory_items')
    .select('id, name, active, created_at')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true })

  if (!allItems || allItems.length === 0) {
    return { error: null, merged: 0, message: 'No inventory items found.' }
  }

  // Group by normalized name
  const groups = new Map<string, typeof allItems>()
  for (const item of allItems) {
    const key = item.name.trim().toLowerCase()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  // Find groups with more than one ACTIVE item — those are unresolved duplicates.
  // Groups with 1 active + N archived are already resolved from a prior merge.
  const unresolvedGroups = [...groups.entries()].filter(
    ([, items]) => items.filter((i) => i.active).length > 1
  )

  const resolvedArchived = [...groups.entries()].filter(
    ([, items]) => items.filter((i) => i.active).length === 1 && items.filter((i) => !i.active).length > 0
  ).length

  if (unresolvedGroups.length === 0) {
    const msg = resolvedArchived > 0
      ? `No active duplicates found. ${resolvedArchived} previously merged group${resolvedArchived > 1 ? 's' : ''} already archived.`
      : 'No active duplicates found.'
    return { error: null, merged: 0, message: msg }
  }

  let totalMerged = 0
  const details: string[] = []

  for (const [, groupItems] of unresolvedGroups) {
    // Score each item: dependents count, prefer active, prefer oldest
    const scored = await Promise.all(
      groupItems.map(async (item) => {
        const [{ count: rc }, { count: ic }, { count: it }] = await Promise.all([
          supabase.from('recipe_components').select('id', { count: 'exact', head: true }).eq('inventory_item_id', item.id),
          supabase.from('inventory_counts').select('id', { count: 'exact', head: true }).eq('inventory_item_id', item.id),
          supabase.from('inventory_transactions').select('id', { count: 'exact', head: true }).eq('inventory_item_id', item.id),
        ])
        return { ...item, deps: (rc ?? 0) + (ic ?? 0) + (it ?? 0) }
      })
    )

    // Sort: most deps first, then active first, then oldest first
    scored.sort((a, b) =>
      b.deps - a.deps ||
      (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )

    const canonical = scored[0]
    const dupes = scored.slice(1)

    // Ensure canonical is active
    if (!canonical.active) {
      await supabase.from('inventory_items').update({ active: true }).eq('id', canonical.id)
    }

    for (const dup of dupes) {
      // Reassign recipe_components (handle unique constraint)
      const { data: dupRc } = await supabase
        .from('recipe_components').select('id, menu_item_id').eq('inventory_item_id', dup.id)
      const { data: canonRc } = await supabase
        .from('recipe_components').select('menu_item_id').eq('inventory_item_id', canonical.id)
      const canonMenuIds = new Set((canonRc ?? []).map((r) => r.menu_item_id))

      for (const rc of dupRc ?? []) {
        if (canonMenuIds.has(rc.menu_item_id)) {
          await supabase.from('recipe_components').delete().eq('id', rc.id)
        } else {
          await supabase.from('recipe_components').update({ inventory_item_id: canonical.id }).eq('id', rc.id)
        }
      }

      // Reassign counts and transactions
      await supabase.from('inventory_counts').update({ inventory_item_id: canonical.id }).eq('inventory_item_id', dup.id)
      await supabase.from('inventory_transactions').update({ inventory_item_id: canonical.id }).eq('inventory_item_id', dup.id)

      // Try to delete the duplicate row
      const { error: delError } = await supabase.from('inventory_items').delete().eq('id', dup.id)

      if (delError) {
        // Fallback: archive it so it no longer appears in active lists
        await supabase.from('inventory_items').update({ active: false }).eq('id', dup.id)
        details.push(`"${dup.name}" — archived (delete blocked: ${delError.message})`)
      } else {
        // Verify it was actually deleted (RLS silent failures return no error but affect 0 rows)
        const { data: stillExists } = await supabase
          .from('inventory_items').select('id').eq('id', dup.id).single()

        if (stillExists) {
          // Delete was silently blocked — archive instead
          await supabase.from('inventory_items').update({ active: false }).eq('id', dup.id)
          details.push(`"${dup.name}" — archived (delete silently blocked)`)
        }
      }

      totalMerged++
    }

    details.push(`✓ "${canonical.name}" — kept as canonical (${canonical.deps} refs)`)
  }

  revalidatePath('/inventory')
  revalidatePath('/menu')
  revalidatePath('/dashboard')

  return {
    error: null,
    merged: totalMerged,
    groups: unresolvedGroups.length,
    details,
    message: `Resolved ${totalMerged} duplicate${totalMerged > 1 ? 's' : ''} across ${unresolvedGroups.length} group${unresolvedGroups.length > 1 ? 's' : ''}.`,
  }
}

// ================================================================
// INTEGRITY CHECKS
// ================================================================

interface IntegrityIssue {
  type: 'auto_fixed' | 'warning'
  category: string
  message: string
}

export async function runInventoryIntegrityChecks() {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.', issues: [] }

  const { supabase, restaurantId } = ctx
  const issues: IntegrityIssue[] = []

  // ---- Duplicate detection (active conflicts only) ----
  const { data: allItems } = await supabase
    .from('inventory_items')
    .select('id, name, active')
    .eq('restaurant_id', restaurantId)

  // Group ALL items by normalized name (for unit mismatch check later)
  const nameGroups = new Map<string, typeof allItems>()
  for (const item of allItems ?? []) {
    const key = item.name.trim().toLowerCase()
    if (!nameGroups.has(key)) nameGroups.set(key, [])
    nameGroups.get(key)!.push(item)
  }

  // Count only ACTIVE duplicates — archived merge leftovers are resolved
  let activeDupCount = 0
  let resolvedArchiveCount = 0
  for (const [, items] of nameGroups) {
    const activeInGroup = items!.filter((i) => i.active)
    const archivedInGroup = items!.filter((i) => !i.active)
    if (activeInGroup.length > 1) {
      activeDupCount += activeInGroup.length - 1
    }
    if (activeInGroup.length === 1 && archivedInGroup.length > 0) {
      resolvedArchiveCount += archivedInGroup.length
    }
  }

  if (activeDupCount > 0) {
    issues.push({
      type: 'warning',
      category: 'Active duplicates',
      message: `${activeDupCount} active duplicate${activeDupCount > 1 ? 's' : ''} found. Run "Merge duplicates" to resolve.`,
    })
  }
  if (resolvedArchiveCount > 0) {
    issues.push({
      type: 'auto_fixed',
      category: 'Resolved duplicates',
      message: `${resolvedArchiveCount} previously merged duplicate${resolvedArchiveCount > 1 ? 's' : ''} archived for history.`,
    })
  }

  // ---- AUTO-FIX: Orphaned recipe components ----
  const { data: recipes } = await supabase
    .from('recipe_components')
    .select('id, inventory_item_id, inventory_items ( id )')

  let orphanedRc = 0
  for (const rc of recipes ?? []) {
    const inv = rc.inventory_items as unknown as { id: string } | null
    if (!inv) {
      await supabase.from('recipe_components').delete().eq('id', rc.id)
      orphanedRc++
    }
  }
  if (orphanedRc > 0) {
    issues.push({
      type: 'auto_fixed',
      category: 'Orphaned records',
      message: `Removed ${orphanedRc} recipe component${orphanedRc > 1 ? 's' : ''} referencing deleted inventory items.`,
    })
  }

  // ---- WARNING: Same name, different units ----
  for (const [normName, items] of nameGroups) {
    if (items!.length <= 1) continue
    const units = new Set(items!.map(() => ''))  // can't get unit from current select
    // Re-fetch with unit for this check
    const { data: withUnits } = await supabase
      .from('inventory_items')
      .select('unit_of_measure')
      .eq('restaurant_id', restaurantId)
      .ilike('name', normName)

    const uniqueUnits = new Set((withUnits ?? []).map((i) => i.unit_of_measure))
    if (uniqueUnits.size > 1) {
      issues.push({
        type: 'warning',
        category: 'Unit mismatch',
        message: `"${normName}" has items with different units: ${[...uniqueUnits].join(', ')}`,
      })
    }
  }

  // ---- WARNING: Archived items still in active recipes ----
  const { data: archivedInRecipes } = await supabase
    .from('recipe_components')
    .select('inventory_items!inner ( name, active )')
    .eq('inventory_items.active', false)

  if ((archivedInRecipes ?? []).length > 0) {
    const names = new Set(
      (archivedInRecipes ?? []).map((r) =>
        (r.inventory_items as unknown as { name: string })?.name
      ).filter(Boolean)
    )
    issues.push({
      type: 'warning',
      category: 'Archived in recipes',
      message: `${names.size} archived item${names.size > 1 ? 's' : ''} still used in active recipes: ${[...names].slice(0, 3).join(', ')}${names.size > 3 ? '…' : ''}`,
    })
  }

  // ---- WARNING: Items with transactions but never counted ----
  const { data: activeItems } = await supabase
    .from('inventory_items')
    .select('id, name')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)

  for (const item of activeItems ?? []) {
    const { count: countCount } = await supabase
      .from('inventory_counts')
      .select('id', { count: 'exact', head: true })
      .eq('inventory_item_id', item.id)

    if ((countCount ?? 0) === 0) {
      const { count: txCount } = await supabase
        .from('inventory_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('inventory_item_id', item.id)

      if ((txCount ?? 0) > 0) {
        issues.push({
          type: 'warning',
          category: 'Never counted',
          message: `"${item.name}" has ${txCount} transaction${(txCount ?? 0) > 1 ? 's' : ''} but no recorded count.`,
        })
      }
    }
  }

  revalidatePath('/inventory')

  return { error: null, issues }
}
