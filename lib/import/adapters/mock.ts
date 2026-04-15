// ----------------------------------------------------------------
// Mock Source Adapter — Pilot V1 testing.
//
// A self-contained adapter with stable sample data. Lets the whole
// ingest pipeline be exercised end-to-end without real credentials
// or a file upload.
//
// Data is intentionally imperfect to exercise the safety rules:
//   • `itm_special` has no category         → tests the
//                                              Uncategorized fallback
//   • `ord_0002` references `itm_ghost`     → tests the
//                                              placeholder-item creation
// ----------------------------------------------------------------

import type { SourceAdapter, AdapterContext } from '../adapter'
import type { NormalizedMenu, NormalizedOrder } from '../types'

const MOCK_CATEGORIES = [
  { externalId: 'cat_apps',   name: 'Appetizers', sortOrder: 1 },
  { externalId: 'cat_mains',  name: 'Mains',      sortOrder: 2 },
  { externalId: 'cat_drinks', name: 'Drinks',     sortOrder: 3 },
]

const MOCK_ITEMS = [
  { externalId: 'itm_fries',   name: 'Crispy Fries',    price: 5.50,  categoryExternalId: 'cat_apps',   active: true },
  { externalId: 'itm_wings',   name: 'Buffalo Wings',   price: 9.00,  categoryExternalId: 'cat_apps',   active: true },
  { externalId: 'itm_burger',  name: 'House Burger',    price: 14.00, categoryExternalId: 'cat_mains',  active: true },
  { externalId: 'itm_salmon',  name: 'Grilled Salmon',  price: 22.00, categoryExternalId: 'cat_mains',  active: true },
  { externalId: 'itm_pasta',   name: 'Pasta Primavera', price: 16.00, categoryExternalId: 'cat_mains',  active: true },
  { externalId: 'itm_cola',    name: 'Cola',            price: 3.50,  categoryExternalId: 'cat_drinks', active: true },
  { externalId: 'itm_beer',    name: 'Draft Beer',      price: 6.00,  categoryExternalId: 'cat_drinks', active: true },
  // Intentional: no categoryExternalId → tests the "Imported · Uncategorized" fallback.
  { externalId: 'itm_special', name: 'Daily Special',   price: 18.00, categoryExternalId: null,         active: true },
]

function nowMinusMinutes(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString()
}

export const mockSourceAdapter: SourceAdapter = {
  id: 'mock',
  kind: 'mock',
  label: 'Mock (Pilot V1 testing)',

  async listMenu(): Promise<NormalizedMenu> {
    return { categories: MOCK_CATEGORIES, items: MOCK_ITEMS }
  },

  async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
    const sinceTs = ctx.since ? ctx.since.getTime() : 0

    const orders: NormalizedOrder[] = [
      {
        externalId: 'ord_0001',
        postedAt: nowMinusMinutes(180),
        totalAmount: 19.50,
        status: 'completed',
        paymentType: 'card',
        lineItems: [
          { externalItemId: 'itm_burger', itemName: 'House Burger', quantity: 1, unitPrice: 14.00, totalPrice: 14.00 },
          { externalItemId: 'itm_fries',  itemName: 'Crispy Fries', quantity: 1, unitPrice: 5.50,  totalPrice: 5.50 },
        ],
      },
      {
        externalId: 'ord_0002',
        postedAt: nowMinusMinutes(60),
        totalAmount: 31.50,
        status: 'completed',
        paymentType: 'cash',
        lineItems: [
          { externalItemId: 'itm_salmon', itemName: 'Grilled Salmon', quantity: 1, unitPrice: 22.00, totalPrice: 22.00 },
          { externalItemId: 'itm_beer',   itemName: 'Draft Beer',     quantity: 1, unitPrice: 6.00,  totalPrice: 6.00 },
          // Ghost item — references an item that was never imported. The
          // ingest layer should create a placeholder, not fail the order.
          { externalItemId: 'itm_ghost',  itemName: 'Mystery Dip',    quantity: 1, unitPrice: 3.50,  totalPrice: 3.50 },
        ],
      },
      {
        externalId: 'ord_0003',
        postedAt: nowMinusMinutes(15),
        totalAmount: 12.50,
        status: 'completed',
        paymentType: 'card',
        lineItems: [
          { externalItemId: 'itm_wings', itemName: 'Buffalo Wings', quantity: 1, unitPrice: 9.00, totalPrice: 9.00 },
          { externalItemId: 'itm_cola',  itemName: 'Cola',          quantity: 1, unitPrice: 3.50, totalPrice: 3.50 },
        ],
      },
    ]

    return orders.filter((o) => new Date(o.postedAt).getTime() >= sinceTs)
  },
}
