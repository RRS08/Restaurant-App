// ----------------------------------------------------------------
// Finance constants — shared between server actions and client components
//
// This file has NO 'use server' or 'use client' directive.
// That makes it safe to import from both environments.
// ----------------------------------------------------------------

export const EXPENSE_CATEGORIES = [
  'Inventory Purchase',
  'Beverage Purchase',
  'Labor',
  'Rent',
  'Utilities',
  'Maintenance',
  'Marketing',
  'Supplies',
  'Miscellaneous',
] as const
