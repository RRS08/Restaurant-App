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
// SINGLE-PAIR MANUAL MERGE
//
// Exposed for the Inventory page's manual merge drawer. The bulk
// `cleanupDuplicateInventoryItems` below picks the canonical row by
// score; this entry point lets the user pick both items explicitly,
// which is the only safe path when:
//   • one of the duplicates is already archived,
//   • the items are not exact name matches but the user knows they
//     should be one row, or
//   • the bulk auto-canonical heuristic would pick the "wrong" row.
//
// Re-points every dependent reference (recipe_components,
// inventory_counts, inventory_transactions) from `duplicateId` →
// `canonicalId`, ensures the canonical is active, then deletes the
// duplicate row (falls back to archive if delete is blocked).
// ================================================================
export async function mergeInventoryItems(
  canonicalId: string,
  duplicateId: string
): Promise<{ error: string | null; message: string }> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.', message: '' }

  if (!canonicalId || !duplicateId) {
    return { error: 'Both items must be selected.', message: '' }
  }
  if (canonicalId === duplicateId) {
    return { error: 'Canonical and duplicate must be different items.', message: '' }
  }

  const { supabase, restaurantId } = ctx

  // Verify both items exist in this restaurant. RLS would silently
  // filter cross-tenant access, but an explicit lookup gives us a
  // friendlier "not found" error and the names for the result message.
  const { data: itemsFound, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, active')
    .eq('restaurant_id', restaurantId)
    .in('id', [canonicalId, duplicateId])

  if (itemErr) return { error: itemErr.message, message: '' }
  if (!itemsFound || itemsFound.length !== 2) {
    return { error: 'One or both items could not be found in this restaurant.', message: '' }
  }

  const canonical = itemsFound.find((i) => i.id === canonicalId)!
  const duplicate = itemsFound.find((i) => i.id === duplicateId)!

  // Ensure canonical is active — a merge implies "this is the row we
  // keep using," so reactivate if the user picked an archived one.
  if (!canonical.active) {
    await supabase.from('inventory_items').update({ active: true }).eq('id', canonical.id)
  }

  // Re-point recipe_components. The unique(menu_item_id,
  // inventory_item_id) constraint means we need to delete-conflicting
  // rows instead of update-conflicting them.
  const { data: dupRc } = await supabase
    .from('recipe_components').select('id, menu_item_id').eq('inventory_item_id', duplicate.id)
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

  // Re-point counts + transactions wholesale (no unique constraints).
  await supabase.from('inventory_counts').update({ inventory_item_id: canonical.id }).eq('inventory_item_id', duplicate.id)
  await supabase.from('inventory_transactions').update({ inventory_item_id: canonical.id }).eq('inventory_item_id', duplicate.id)

  // Try to delete the duplicate; fall back to archive if blocked
  // (matches the bulk action's safety pattern).
  let finalNote = 'deleted'
  const { error: delError } = await supabase.from('inventory_items').delete().eq('id', duplicate.id)
  if (delError) {
    await supabase.from('inventory_items').update({ active: false }).eq('id', duplicate.id)
    finalNote = `archived (delete blocked: ${delError.message})`
  } else {
    const { data: stillExists } = await supabase
      .from('inventory_items').select('id').eq('id', duplicate.id).maybeSingle()
    if (stillExists) {
      await supabase.from('inventory_items').update({ active: false }).eq('id', duplicate.id)
      finalNote = 'archived (delete silently blocked)'
    }
  }

  revalidatePath('/inventory')
  revalidatePath('/menu')
  revalidatePath('/pos')
  revalidatePath('/dashboard')

  return {
    error: null,
    message: `Merged "${duplicate.name}" into "${canonical.name}" — duplicate ${finalNote}.`,
  }
}

// ================================================================
// DUPLICATE MERGE (BULK)
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

  // Unresolved duplicates fall into two cases:
  //   (a) 2+ active items sharing a name (classic case).
  //   (b) 1 active + 1+ archived items sharing a name where the
  //       archived row still has dependencies (counts / recipe links
  //       / transactions). The previous filter (active > 1) missed
  //       (b) entirely — that's the most common "depletion writes
  //       exist in the DB but the visible row doesn't move" case.
  //
  // We probe deps via head:true counts so we don't pull row bodies.
  async function hasDeps(itemId: string): Promise<boolean> {
    const [{ count: rc }, { count: ic }, { count: it }] = await Promise.all([
      supabase.from('recipe_components').select('id', { count: 'exact', head: true }).eq('inventory_item_id', itemId),
      supabase.from('inventory_counts').select('id', { count: 'exact', head: true }).eq('inventory_item_id', itemId),
      supabase.from('inventory_transactions').select('id', { count: 'exact', head: true }).eq('inventory_item_id', itemId),
    ])
    return (rc ?? 0) + (ic ?? 0) + (it ?? 0) > 0
  }

  const candidateGroups = [...groups.entries()].filter(
    ([, items]) => items.length > 1 && items.some((i) => i.active)
  )

  const unresolvedGroups: typeof candidateGroups = []
  let resolvedArchived = 0
  for (const entry of candidateGroups) {
    const [, items] = entry
    const activeCount = items.filter((i) => i.active).length
    if (activeCount >= 2) {
      unresolvedGroups.push(entry)
      continue
    }
    // 1 active + N archived — check whether any archived row still
    // carries dependencies. If yes, unresolved. If no, it's already-
    // merged residue and we just count it for the message.
    const archived = items.filter((i) => !i.active)
    let anyArchivedHasDeps = false
    for (const a of archived) {
      if (await hasDeps(a.id)) { anyArchivedHasDeps = true; break }
    }
    if (anyArchivedHasDeps) {
      unresolvedGroups.push(entry)
    } else {
      resolvedArchived += 1
    }
  }

  if (unresolvedGroups.length === 0) {
    const msg = resolvedArchived > 0
      ? `No unresolved duplicates found. ${resolvedArchived} previously merged group${resolvedArchived > 1 ? 's' : ''} already archived.`
      : 'No unresolved duplicates found.'
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

  // ---- AUTO-FIX: Archived items still in active recipes ----
  //
  // Root cause documented in detail elsewhere: an archived
  // `inventory_items` row that's still referenced by an active
  // `recipe_components` row is a silent inconsistency. POS depletion
  // queries `recipe_components` with no active-state filter, finds
  // the archived inventory_item_id, and writes the usage row to it.
  // The Inventory page render filters `active=true` before mapping
  // into the table, so the archived row never appears — depletion
  // writes accumulate on a row the user cannot see. From the user's
  // POV, "stock isn't moving."
  //
  // The repair is reactivation: an active recipe link means the item
  // IS in operational use, so the archived state was always
  // contradictory. We reactivate inline; archiving is now blocked at
  // the `archiveInventoryItem` action when recipes still reference
  // the item, so this state should not recur.
  const { data: archivedInRecipes } = await supabase
    .from('recipe_components')
    .select('inventory_item_id, inventory_items!inner ( id, name, active )')
    .eq('inventory_items.active', false)

  const reactivatedIds = new Set<string>()
  const reactivatedNames = new Set<string>()
  for (const rc of archivedInRecipes ?? []) {
    const inv = rc.inventory_items as unknown as { id: string; name: string } | null
    if (inv) {
      reactivatedIds.add(inv.id)
      reactivatedNames.add(inv.name)
    }
  }

  if (reactivatedIds.size > 0) {
    await supabase
      .from('inventory_items')
      .update({ active: true })
      .in('id', [...reactivatedIds])

    const sample = [...reactivatedNames].slice(0, 3).join(', ')
    const more = reactivatedNames.size > 3 ? '…' : ''
    issues.push({
      type: 'auto_fixed',
      category: 'Reactivated recipe-linked items',
      message: `Reactivated ${reactivatedIds.size} archived item${reactivatedIds.size > 1 ? 's' : ''} still used in active recipes (depletion was writing to invisible rows): ${sample}${more}`,
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
