// ----------------------------------------------------------------
// Lead capture — writes a site_leads row from a lead-form POST.
//
// Called from the site render route handler when it sees a POST
// containing `_form` (the form_key hidden field). Runs with the
// service-role client because visitors are anonymous and RLS on
// site_leads doesn't grant anon INSERT.
//
// Denormalizes contact_name / _email / _phone from the payload
// when present so the dashboard can filter without unpacking JSONB.
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'

export interface LeadInput {
  siteId: string
  formKey: string
  payload: Record<string, string>
  sourcePath: string | null
  userAgent: string | null
  ipAddress: string | null
  referer: string | null
}

export async function createLead(input: LeadInput): Promise<{ id: string } | { error: string }> {
  const supabase = createAdminClient()
  const contactName = firstString(input.payload, ['name', 'full_name', 'contact_name'])
  const contactEmail = firstString(input.payload, ['email', 'contact_email'])
  const contactPhone = firstString(input.payload, ['phone', 'contact_phone'])

  const { data, error } = await supabase
    .from('site_leads')
    .insert({
      site_id: input.siteId,
      form_key: input.formKey,
      payload: input.payload,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: contactPhone,
      source_path: input.sourcePath,
      user_agent: input.userAgent,
      ip_address: input.ipAddress,
      referer: input.referer,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[sites/createLead] insert failed', error)
    return { error: error.message }
  }
  return { id: data.id as string }
}

function firstString(obj: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
}
