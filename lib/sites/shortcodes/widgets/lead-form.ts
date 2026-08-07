// ----------------------------------------------------------------
// {{lead-form}} widget.
//
// Renders a lead-capture form that POSTs back to the SAME URL —
// the site's route handler picks up POSTs on any page and writes a
// `site_leads` row keyed by `_form`. Works with JS off; the tiny
// inline script only swaps the form for the thanks state after a
// successful redirect back with ?lead-form-submitted=<form_key>.
//
// The markup here uses the `.lf` class family from the site's
// global CSS — no inline <style> block anymore. If a widget renders
// on a site that doesn't ship the .lf styles, the form still works
// (all inputs render as plain HTML defaults); it just looks bare.
//
// Attributes:
//   form     "contact"                   — the _form key filed on
//                                          the lead row
//   fields   "name,email,phone,message"  — render order; known keys
//                                          get typed inputs +
//                                          placeholders, anything
//                                          else falls back to a
//                                          plain text input
//   submit   "Send message"              — submit button label
//   thanks   "Thanks — we'll be in touch soon."
//                                        — success state message
//
// Field defaults per key (from Design's spec):
//   name    text     required, "Your name"
//   email   email    required, "you@email.com"
//   phone   tel      optional, "(956) 000-0000"
//   message textarea required, "What can we help with?"
// ----------------------------------------------------------------

import type { ShortcodeArgs, ShortcodeContext } from '../index'
import { escapeAttr, escapeHtml } from '../utils'

const DEFAULT_FIELDS = ['name', 'email', 'phone', 'message']

interface FieldSpec {
  key: string
  label: string
  type: 'text' | 'email' | 'tel' | 'textarea'
  placeholder: string
  required: boolean
}

const KNOWN_FIELDS: Record<string, FieldSpec> = {
  name:    { key: 'name',    label: 'Name',    type: 'text',     placeholder: 'Your name',              required: true },
  email:   { key: 'email',   label: 'Email',   type: 'email',    placeholder: 'you@email.com',          required: true },
  phone:   { key: 'phone',   label: 'Phone',   type: 'tel',      placeholder: '(956) 000-0000',         required: false },
  message: { key: 'message', label: 'Message', type: 'textarea', placeholder: 'What can we help with?', required: true },
  company: { key: 'company', label: 'Company', type: 'text',     placeholder: 'Acme Inc.',              required: false },
}

function fieldSpec(key: string): FieldSpec {
  return KNOWN_FIELDS[key] ?? { key, label: titleize(key), type: 'text', placeholder: '', required: false }
}

function titleize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function renderLeadForm(args: ShortcodeArgs, _ctx: ShortcodeContext): string {
  const formKey = String(args.form ?? 'default')
  const submitLabel = String(args.submit ?? args.button ?? 'Send message')
  const thanksMsg = String(args.thanks ?? "Thanks — we'll be in touch soon.")

  const fieldKeys = typeof args.fields === 'string'
    ? args.fields.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_FIELDS
  const fields = fieldKeys.map(fieldSpec)

  const formBlockId = `lf-form-${cssId(formKey)}`
  const thanksBlockId = `lf-thanks-${cssId(formKey)}`
  const fieldHTML = fields.map(renderField).join('\n')

  // Both blocks render; the inline script hides the form and shows
  // the thanks state when the URL carries the submitted marker for
  // this form key. Without JS, a submitter sees both blocks after
  // the redirect — degraded but not broken.
  return `<form class="lf" id="${escapeAttr(formBlockId)}" method="post" action="?">
  <input type="hidden" name="_form" value="${escapeAttr(formKey)}">
${fieldHTML}
  <button type="submit">${escapeHtml(submitLabel)}</button>
</form>
<div class="lf-success" id="${escapeAttr(thanksBlockId)}" style="display:none">${escapeHtml(thanksMsg)}</div>
<script>
(function(){
  try{
    var q=new URLSearchParams(window.location.search);
    if(q.get('lead-form-submitted')===${JSON.stringify(formKey)}){
      var f=document.getElementById(${JSON.stringify(formBlockId)});
      var t=document.getElementById(${JSON.stringify(thanksBlockId)});
      if(f){f.style.display='none'}
      if(t){t.style.display='block'}
    }
  }catch(e){}
})();
</script>`
}

function renderField(f: FieldSpec): string {
  const id = `lf-${cssId(f.key)}`
  const optionalLabel = f.required ? '' : ' <span class="opt">(optional)</span>'
  const label = `<label for="${escapeAttr(id)}">${escapeHtml(f.label)}${optionalLabel}</label>`
  const required = f.required ? ' required' : ''

  if (f.type === 'textarea') {
    return `  <div>
    ${label}
    <textarea id="${escapeAttr(id)}" name="${escapeAttr(f.key)}" placeholder="${escapeAttr(f.placeholder)}"${required}></textarea>
  </div>`
  }
  return `  <div>
    ${label}
    <input id="${escapeAttr(id)}" name="${escapeAttr(f.key)}" type="${escapeAttr(f.type)}" placeholder="${escapeAttr(f.placeholder)}"${required}>
  </div>`
}

function cssId(s: string): string {
  return s.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}
