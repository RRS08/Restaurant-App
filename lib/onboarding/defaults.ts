// ----------------------------------------------------------------
// Onboarding defaults — recommendations, menu sections, role
// matrix, inventory preview seeds. One source of truth.
// ----------------------------------------------------------------

import type { BusinessType, SchedulingStyle, TeamModel } from './types'

// ================================================================
// Recommended defaults per business type
// ================================================================

export const RECOMMENDED_TEAM_MODEL: Record<BusinessType, TeamModel> = {
  full_service: 'foh_boh',
  quick_service: 'prep_service',
  food_truck: 'unified',
  cafe: 'unified',
  bar: 'foh_boh',
}

export const RECOMMENDED_SCHEDULING: Record<BusinessType, SchedulingStyle> = {
  full_service: 'by_role',
  quick_service: 'by_shift_block',
  food_truck: 'by_shift_block',
  cafe: 'by_shift_block',
  bar: 'by_role',
}

// ================================================================
// Starter menu sections (seeded from onboarding, editable later)
// ================================================================

export const STARTER_MENU_SECTIONS: Record<BusinessType, string[]> = {
  full_service: ['Appetizers', 'Entrees', 'Sides', 'Desserts', 'Soft Drinks', 'Cocktails'],
  quick_service: ['Combos', 'Mains', 'Sides', 'Drinks', 'Add-ons'],
  food_truck: ['Mains', 'Sides', 'Drinks', 'Specials'],
  cafe: ['Coffee', 'Tea', 'Pastries', 'Food', 'Specials'],
  bar: ['Cocktails', 'Beer', 'Food', 'Specials'],
}

// ================================================================
// Role matrix — keyed by (businessType, teamModel)
// ================================================================

export interface RoleBucket { recommended: string[]; extras: string[] }

export interface RoleMatrixEntry {
  groupALabel: string
  groupBLabel: string | null
  groupA: RoleBucket
  groupB: RoleBucket | null
}

type MatrixKey = `${BusinessType}:${TeamModel}`

const M: Record<MatrixKey, RoleMatrixEntry> = {
  // Full-Service
  'full_service:foh_boh': {
    groupALabel: 'Front of House', groupBLabel: 'Back of House',
    groupA: { recommended: ['Server','Host','Busser','Food Runner','FOH Manager'], extras: ['Bartender','Cashier','Expo / To-Go'] },
    groupB: { recommended: ['Line Cook','Prep Cook','Dishwasher'], extras: ['Expo','Kitchen Lead','BOH Manager'] },
  },
  'full_service:unified': {
    groupALabel: 'Team roles', groupBLabel: null,
    groupA: { recommended: ['Server','Host','Bartender','Cook','Prep','Dishwasher','Manager'], extras: ['Busser','Runner','Cashier'] },
    groupB: null,
  },
  'full_service:prep_service': {
    groupALabel: 'Service', groupBLabel: 'Prep',
    groupA: { recommended: ['Server','Host','Busser','Runner'], extras: ['Bartender','Cashier'] },
    groupB: { recommended: ['Line Cook','Prep Cook','Dishwasher'], extras: ['Expo','Kitchen Lead'] },
  },
  // Quick Service
  'quick_service:foh_boh': {
    groupALabel: 'Front of House', groupBLabel: 'Back of House',
    groupA: { recommended: ['Cashier','Service Lead'], extras: ['Runner','FOH Manager'] },
    groupB: { recommended: ['Cook','Prep','Assembler'], extras: ['Dishwasher','Kitchen Lead'] },
  },
  'quick_service:unified': {
    groupALabel: 'Team roles', groupBLabel: null,
    groupA: { recommended: ['Cashier','Cook','Prep','Assembler','Shift Lead'], extras: ['Runner','Manager'] },
    groupB: null,
  },
  'quick_service:prep_service': {
    groupALabel: 'Service', groupBLabel: 'Prep',
    groupA: { recommended: ['Cashier','Runner','Service Lead'], extras: [] },
    groupB: { recommended: ['Cook','Prep','Assembler'], extras: ['Dishwasher','Kitchen Lead'] },
  },
  // Food Truck
  'food_truck:foh_boh': {
    groupALabel: 'Front of House', groupBLabel: 'Back of House',
    groupA: { recommended: ['Cashier','Service'], extras: ['Lead'] },
    groupB: { recommended: ['Cook','Prep'], extras: ['Lead'] },
  },
  'food_truck:unified': {
    groupALabel: 'Team roles', groupBLabel: null,
    groupA: { recommended: ['Cashier','Cook','Prep','Service','Lead'], extras: ['Manager'] },
    groupB: null,
  },
  'food_truck:prep_service': {
    groupALabel: 'Service', groupBLabel: 'Prep',
    groupA: { recommended: ['Cashier','Service'], extras: ['Lead'] },
    groupB: { recommended: ['Cook','Prep'], extras: ['Lead'] },
  },
  // Cafe
  'cafe:foh_boh': {
    groupALabel: 'Front of House', groupBLabel: 'Back of House',
    groupA: { recommended: ['Barista','Cashier','Service Lead'], extras: ['Manager'] },
    groupB: { recommended: ['Prep'], extras: ['Dishwasher','Manager'] },
  },
  'cafe:unified': {
    groupALabel: 'Team roles', groupBLabel: null,
    groupA: { recommended: ['Barista','Cashier','Prep','Shift Lead'], extras: ['Service','Manager'] },
    groupB: null,
  },
  'cafe:prep_service': {
    groupALabel: 'Service', groupBLabel: 'Prep',
    groupA: { recommended: ['Barista','Cashier'], extras: ['Shift Lead','Manager'] },
    groupB: { recommended: ['Prep'], extras: ['Shift Lead','Manager'] },
  },
  // Bar / Pub
  'bar:foh_boh': {
    groupALabel: 'Front of House', groupBLabel: 'Back of House',
    groupA: { recommended: ['Bartender','Server','Host','FOH Manager'], extras: ['Barback','Runner'] },
    groupB: { recommended: ['Cook','Prep'], extras: ['Dishwasher','Kitchen Lead'] },
  },
  'bar:unified': {
    groupALabel: 'Team roles', groupBLabel: null,
    groupA: { recommended: ['Bartender','Server','Cook','Prep','Manager'], extras: ['Host','Barback'] },
    groupB: null,
  },
  'bar:prep_service': {
    groupALabel: 'Service', groupBLabel: 'Prep',
    groupA: { recommended: ['Bartender','Server','Host'], extras: ['Barback','Manager'] },
    groupB: { recommended: ['Cook','Prep'], extras: ['Manager'] },
  },
}

export function getRoleMatrix(bt: BusinessType, tm: TeamModel): RoleMatrixEntry {
  return M[`${bt}:${tm}` as MatrixKey]
}

// ================================================================
// Role selection validation
// ================================================================

export function isRoleSelectionValid(tm: TeamModel, a: string[], b: string[]): boolean {
  if (tm === 'unified') return a.length >= 1
  return a.length >= 1 && b.length >= 1
}

// ================================================================
// Inventory preview seeds (never persisted — display only)
// ================================================================

export interface PreviewItem {
  name: string; unit: string; onHand: number; threshold: number
  status: 'out' | 'low' | 'ok' | 'no_count'
}

export const PREVIEW_INVENTORY: Record<BusinessType, PreviewItem[]> = {
  full_service: [
    { name: 'Chicken breast', unit: 'lbs', onHand: 18, threshold: 20, status: 'low' },
    { name: 'Pasta', unit: 'lbs', onHand: 40, threshold: 15, status: 'ok' },
    { name: 'Heavy cream', unit: 'qts', onHand: 0, threshold: 6, status: 'out' },
    { name: 'Fresh herbs', unit: 'bunches', onHand: 12, threshold: 8, status: 'ok' },
    { name: 'Cheesecake', unit: 'slices', onHand: 0, threshold: 0, status: 'no_count' },
  ],
  quick_service: [
    { name: 'Buns', unit: 'pk', onHand: 6, threshold: 10, status: 'low' },
    { name: 'Beef patties', unit: 'cases', onHand: 3, threshold: 2, status: 'ok' },
    { name: 'Fries', unit: 'bags', onHand: 0, threshold: 4, status: 'out' },
    { name: 'Soda syrup', unit: 'gal', onHand: 8, threshold: 3, status: 'ok' },
    { name: 'Takeout bags', unit: 'ct', onHand: 0, threshold: 0, status: 'no_count' },
  ],
  food_truck: [
    { name: 'Flour tortillas', unit: 'pk', onHand: 4, threshold: 6, status: 'low' },
    { name: 'Salsa verde', unit: 'qts', onHand: 3, threshold: 2, status: 'ok' },
    { name: 'Carnitas', unit: 'lbs', onHand: 0, threshold: 10, status: 'out' },
    { name: 'Soda cans', unit: 'cases', onHand: 5, threshold: 2, status: 'ok' },
    { name: 'Serving trays', unit: 'ct', onHand: 0, threshold: 0, status: 'no_count' },
  ],
  cafe: [
    { name: 'Coffee beans', unit: 'lbs', onHand: 8, threshold: 10, status: 'low' },
    { name: 'Whole milk', unit: 'gal', onHand: 6, threshold: 3, status: 'ok' },
    { name: 'Vanilla syrup', unit: 'btls', onHand: 0, threshold: 2, status: 'out' },
    { name: 'Pastries', unit: 'ct', onHand: 18, threshold: 6, status: 'ok' },
    { name: 'Paper cups', unit: 'sleeves', onHand: 0, threshold: 0, status: 'no_count' },
  ],
  bar: [
    { name: 'Vodka (well)', unit: 'btls', onHand: 2, threshold: 4, status: 'low' },
    { name: 'IPA keg', unit: 'keg', onHand: 1, threshold: 1, status: 'ok' },
    { name: 'Fresh limes', unit: 'cases', onHand: 0, threshold: 1, status: 'out' },
    { name: 'Bar napkins', unit: 'packs', onHand: 20, threshold: 5, status: 'ok' },
    { name: 'Burger beef', unit: 'lbs', onHand: 0, threshold: 0, status: 'no_count' },
  ],
}
