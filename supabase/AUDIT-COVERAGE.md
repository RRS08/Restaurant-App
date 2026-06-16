# Audit Log Coverage

> Run: 2026-06-16. Companion to `SECURITY-AUDIT.md` and `ROLES-AUDIT.md`.
> The `audit_logs` table exists in the schema and `lib/auth.ts` exports
> a fire-and-forget `logAudit()` helper. This document tracks which
> server actions actually call it.

## Coverage snapshot (logAudit calls / total exported actions per file)

| File | Coverage | Notes |
|---|---|---|
| `team.ts` | 2 / 3 | invite + cancel logged. Accept logged on the user side via `accepted_at`. |
| `sales.ts` | 3 / 2 | order create + void logged |
| `finance.ts` | 1 / 1 | expense create logged |
| `inventory.ts` | 10 / 16 | most operational writes logged |
| `staffing.ts` | 6 / 13 | shift writes + employee changes logged; structural changes now logged in this pass |
| `menu.ts` | 4 / 8 | destructive + override logged in this pass; updates still un-logged |
| `recipe.ts` | 3 / 4 | recipe component CRUD logged in this pass |
| `inventory-cleanup.ts` | 3 / 3 | merge + cleanup + integrity logged in this pass |
| `pos-import.ts` | 4 / 8 | integration + import events logged in this pass |
| `bank.ts` | 0 / 17 | **GAP** — bank connection / disconnect / sync are unlogged |
| `payments.ts` | 0 / 7 | **GAP** — provider config + payment intent lifecycle unlogged |
| `clover.ts` | 0 / 5 | **GAP** — Clover config + connection events unlogged |
| `square.ts` | 0 / 3 | **GAP** — Square config events unlogged |
| `onboarding.ts` | 0 / 5 | **GAP** — bootstrap + mode + activation unlogged |
| `auth.ts` | 0 / 5 | not applicable — auth writes go through Supabase Auth's own logs |
| `dev.ts` | 0 / 4 | dev-only; lower priority |
| `external-pos-reset.ts` | 0 / 1 | should log the reset action |

## What this pass covered

Added `logAudit()` to the highest-impact destructive + structural writes that didn't have it:
- menu: `deleteMenuItem`, `deleteCategory`, `setMenuItemActive`, `updateMenuItemPrice`
- recipe: `addRecipeComponent`, `updateRecipeComponentQuantity`, `removeRecipeComponent`
- inventory-cleanup: `mergeInventoryItems`, `cleanupDuplicateInventoryItems`, `runInventoryIntegrityChecks`
- staffing: `addStaffingRole`, `createShiftSection`, `deleteShiftSection`, `clearAllEmployees`, `resetStaffingSetup`
- pos-import: `connectExternalPos`, `disconnectExternalPos`, `syncExternalPosMenu`, `syncExternalPosOrders`

## What's still un-logged (deferred — backlog)

These four files together account for ~32 untouched server actions. They're all owner-level integrations and most are write-once / write-rare:

- **bank.ts** — Plaid link token exchange, bank disconnect, transaction syncs, review-state flips.
  Lower urgency than the 2026-06-16 pass items because Plaid is itself an audit trail at the
  provider side. Add `logAudit` here next.
- **payments.ts** — `setPaymentProviderConfig` (touches secrets!), `createPaymentIntent`,
  `cancelPaymentIntent`, etc. Should be next priority after bank.ts because of the secrets
  involvement.
- **clover.ts** / **square.ts** — config + disconnect. Same priority as bank/payments.
- **onboarding.ts** — `completeOnboarding`, `setOperatingMode`, `activateInventory`. These
  are bootstrap-time events; logging them gives a "when did this restaurant start"
  timeline that's useful for support.

## Pattern reference

For files using `getAuthContext()`:

```ts
const { context: ctx, error: authError } = await getAuthContext()
if (authError || !ctx) return { error: authError }
// ... work ...
await logAudit(ctx, locationIdOrNull, 'action_name', 'entity_type', entityId, { ...metadata })
```

For files that only use `requireRestaurantOwner` from `lib/authz.ts`, the returned
`RestaurantAccessContext` has the same `supabase` + `userId` + `restaurantId` fields you
need. The logging helper would need a slight signature broadening — backlog item.

## Why this matters at launch

The audit log is the "what happened" timeline. Without it, support questions like
"why did Item X disappear from my menu yesterday?" have no answer. Worse, a manager-
level user committing damage (in a hostile takeover or just by accident) leaves no
trace. The Tier-1 destructive actions are now traced; the integration writes still
need this coverage before scaling to multi-restaurant pilots.
