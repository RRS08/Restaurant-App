// ----------------------------------------------------------------
// Canonical onboarding vocabulary.
// Every surface reads from these types — no page invents its own.
// ----------------------------------------------------------------

export type BusinessType = 'full_service' | 'quick_service' | 'food_truck' | 'cafe' | 'bar'
export type TeamModel = 'foh_boh' | 'unified' | 'prep_service'
export type SchedulingStyle = 'by_role' | 'by_shift_block'

export interface OnboardingAnswers {
  restaurantName: string
  locationName: string
  locationAddress: string | null
  locationTimezone: string
  businessType: BusinessType
  teamModel: TeamModel
  schedulingStyle: SchedulingStyle
  rolesGroupA: string[]   // FOH / Service / unified bucket
  rolesGroupB: string[]   // BOH / Prep — empty for unified
  usesExternalPos: boolean
}

// Human labels
export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  full_service: 'Full-Service Restaurant',
  quick_service: 'Quick Service / Fast Food',
  food_truck: 'Food Truck',
  cafe: 'Cafe / Coffee House',
  bar: 'Bar / Pub',
}

export const TEAM_MODEL_LABEL: Record<TeamModel, string> = {
  foh_boh: 'Front + Back of House',
  unified: 'Unified Team',
  prep_service: 'Prep + Service',
}

export const SCHEDULING_STYLE_LABEL: Record<SchedulingStyle, string> = {
  by_role: 'By role',
  by_shift_block: 'By shift block',
}

// Storage mapping: onboarding team model → staffing_config columns.
// foh_boh      → A=foh_roles, B=boh_roles
// unified      → A=foh_roles (single bucket), B empty
// prep_service → A(service)=foh_roles, B(prep)=boh_roles
export function splitRolesForStorage(
  teamModel: TeamModel,
  rolesGroupA: string[],
  rolesGroupB: string[]
): { fohRoles: string[]; bohRoles: string[] } {
  if (teamModel === 'unified') return { fohRoles: rolesGroupA, bohRoles: [] }
  return { fohRoles: rolesGroupA, bohRoles: rolesGroupB }
}
