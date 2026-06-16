# Roles & Permissions Audit

> Run: 2026-06-16. Companion to `SECURITY-AUDIT.md`.
> RLS gates row visibility. This audit covers the *action* layer —
> who can actually call each `app/actions/*` server action, enforced
> via `lib/authz.ts` helpers (`requireRestaurantOwner`,
> `requireLocationAccess`, etc.).

## Net findings

- **21 gaps total** across server actions.
  - **18 MISSING OWNER GUARDS** — actions a non-owner (manager / staff) can currently call.
  - **3 UNDER-PERMISSIVE** — actions that lack location enforcement and could leak across locations in a multi-location restaurant.
- All restaurant-level admin actions (payments, bank, external POS) are correctly owner-gated. The gaps are concentrated in **menu**, **recipe**, **staffing structure**, **imports**, and **inventory cleanup**.

## Authz helpers (from `lib/authz.ts`)

| Helper | Passes | Use for |
|---|---|---|
| `requireAuthenticatedUser()` | any signed-in user | onboarding bootstrap only |
| `getRestaurantAccessContext(restaurantId)` | owner or manager | read paths, non-mutating |
| `requireRestaurantOwner(restaurantId)` | owner only | menu, recipes, integrations, structural config |
| `requireLocationAccess(restaurantId, locationId)` | owner (any location) or manager at that location | location-scoped writes (orders, inventory, shifts, expenses) |
| `requireSelf(userId)` | auth.uid() === userId | account self-management |

`AuthzError.status` is 401 (no user) or 403 (wrong role/location). Server actions catch it and return `{ error: message }` to the form.

## Tier 1 — MISSING OWNER GUARDS (apply BEFORE production)

### `app/actions/pos-import.ts` (4 actions)
- `importCsvMenu`
- `importCsvOrders`
- `importCustomJsonMenu`
- `importCustomJsonOrders`

**Risk:** any manager / staff can upload arbitrary CSV/JSON to overwrite the menu or inject historical orders, bypassing external-POS setup.

**Fix:** add an owner check at the top of each. Pattern matches the file's other actions that already guard correctly (`connectExternalPos`, `syncExternalPosMenu`, etc.).

### `app/actions/menu.ts` (5 actions)
- `createCategory`
- `createMenuItem`
- `createMenuItemInSection`
- `deleteCategory`
- `deleteMenuItem`

**Risk:** managers / staff can build or delete the entire menu, change pricing, or disable items. Likely the single highest-impact gap because the menu is the spine of the POS.

### `app/actions/recipe.ts` (3 actions)
- `addRecipeComponent`
- `updateRecipeComponentQuantity`
- `removeRecipeComponent`

**Risk:** managers can alter recipe ingredient quantities — drives COGS and inventory depletion. A bad-actor manager could under-deduct ingredients to hide waste.

### `app/actions/staffing.ts` (6 actions)
- `addStaffingRole`
- `createShiftSection`
- `updateShiftSection`
- `deleteShiftSection`
- `clearAllEmployees`
- `resetStaffingSetup`

**Risk:** structural staffing changes a manager shouldn't be able to make — adding new role types, deleting shift sections, wiping the entire roster.

### `app/actions/inventory-cleanup.ts` (3 actions)
- `mergeInventoryItems`
- `cleanupDuplicateInventoryItems`
- `runInventoryIntegrityChecks`

**Risk:** destructive merges across locations. Treating these as owner-only is the conservative call.

## Tier 2 — UNDER-PERMISSIVE (defense-in-depth)

### `app/actions/staffing.ts`
- `updateEmployee` — currently has no location check; a manager assigned to Location A could update an employee whose `primary_location_id` is Location B.
- `archiveEmployee` — same problem.

**Fix:** load the employee row, then call `requireLocationAccess(ctx.restaurantId, employee.primary_location_id)` before the mutation.

### `app/actions/recipe.ts`
- `createInlineInventoryItem` — creates an inventory item at a resolved location without verifying the caller has access to that location.

**Fix:** call `requireLocationAccess(ctx.restaurantId, locationId)` after resolving.

## Capability matrix (after fixes are applied)

| Action | Owner | Manager | Staff |
|---|---|---|---|
| View sales | ✓ | ✓ (location-scoped) | ✗ |
| Create order | ✓ | ✓ (location-scoped) | ✗ |
| Void order | ✓ | ✓ (location-scoped) | ✗ |
| Create payment intent | ✓ | ✓ (location-scoped) | ✗ |
| Configure payment provider | ✓ | ✗ | ✗ |
| Connect Square / Clover | ✓ | ✗ | ✗ |
| Import CSV / JSON menu or orders | ✓ | ✗ | ✗ |
| Create / delete menu item or category | ✓ | ✗ | ✗ |
| Add / edit recipe ingredient | ✓ | ✗ | ✗ |
| Create inventory item | ✓ | ✓ (location-scoped) | ✗ |
| Merge inventory duplicates | ✓ | ✗ | ✗ |
| Create inventory count / transaction | ✓ | ✓ (location-scoped) | ✗ |
| Create expense | ✓ | ✓ (location-scoped) | ✗ |
| Create employee | ✓ | ✓ (location-scoped) | ✗ |
| Update / archive employee | ✓ | ✓ (their location only) | ✗ |
| Create shift | ✓ | ✓ (location-scoped) | ✗ |
| Add staffing role / shift section | ✓ | ✗ | ✗ |
| Wipe staffing setup | ✓ | ✗ | ✗ |
| Connect bank (Plaid) | ✓ | ✗ | ✗ |

Notes on `staff` role: it exists in the schema but no server action currently treats it specially. Read-only access for staff (e.g., view their own schedule) would be a future addition — out of scope for this audit.

## Next steps

1. Apply the 18 Tier-1 owner-guard additions.
2. Apply the 3 Tier-2 location checks.
3. Type-check.
4. Manual smoke test: log in as a manager on a test restaurant, attempt each guarded action via the UI, confirm a 403-style error surfaces.
