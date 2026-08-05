// ----------------------------------------------------------------
// {{lead-form}} widget.
//
// Renders a plain HTML form that POSTs back to the SAME URL — the
// site's route handler picks up POSTs on any page and writes a
// `site_leads` row keyed by `form_key`. No JavaScript required
// on the client; works even with scripts blocked.
//
// Supported attributes (all optional):
//   form="customer"          form_key stored on the lead row
//   title="Get a quote"      heading above the fields
//   button="Submit"          submit button label
//   fields="name,email,phone,message"
//                            comma-separated field names to render.
//                            Known keys get sensible input types +
//                            placeholders; anything else falls back
//                            to a plain text input.
//   thanks="Thanks!"         message shown after a successful submit
//                            (rendered by the route handler on
//                            ?lead-form-submitted=<form_key>).
//
// Example:
//   {{lead-form form="driver" title="Apply to drive"
//               fields="name,email,phone,cdl_class,years_driving,message"}}
// ----------------------------------------------------------------

import type { ShortcodeArgs, ShortcodeContext } from '../index'

const DEFAULT_FIELDS = ['name', 'email', 'phone', 'message']

interface FieldSpec {
  key: string
  label: string
  type: 'text' | 'email' | 'tel' | 'textarea'
  placeholder: string
  required: boolean
}

const KNOWN_FIELDS: Record<string, FieldSpec> = {
  name:    { key: 'name',    label: 'Your name',      type: 'text',     placeholder: 'Jane Doe',              required: true },
  email:   { key: 'email',   label: 'Email',          type: 'email',    placeholder: 'you@example.com',       required: true },
  phone:   { key: 'phone',   label: 'Phone',          type: 'tel',      placeholder: '(555) 555-5555',        required: false },
  company: { key: 'company', label: 'Company',        type: 'text',     placeholder: 'Acme Inc.',             required: false },
  message: { key: 'message', label: 'How can we help?', type: 'textarea', placeholder: 'Tell us a bit…',        required: false },
}

function fieldSpec(key: string): FieldSpec {
  return KNOWN_FIELDS[key] ?? {
    key, label: titleize(key), type: 'text', placeholder: '', required: false,
  }
}

function titleize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function renderLeadForm(args: ShortcodeArgs, ctx: ShortcodeContext): string {
  const formKey = String(args.form ?? 'default')
  const title = String(args.title ?? 'Get in touch')
  const buttonLabel = String(args.button ?? 'Send')
  const thanksMsg = String(args.thanks ?? 'Thanks — we got it and will be in touch.')

  const fieldKeys = typeof args.fields === 'string'
    ? args.fields.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_FIELDS
  const fields = fieldKeys.map(fieldSpec)

  // The route handler sets ?lead-form-submitted=<form_key> after a
  // successful POST. Rendering with that param shows the thanks
  // state instead of the empty form so a user who refreshes the
  // page doesn't see their fields still filled in.
  // We render BOTH states server-side and let a tiny inline script
  // toggle based on the query param. Falls back gracefully when
  // JS is off — both blocks are visible, which is a fine outcome.
  const thanksBlockId = `lf-thanks-${cssId(formKey)}`
  const formBlockId = `lf-form-${cssId(formKey)}`

  const fieldHTML = fields.map((f) => renderField(formKey, f)).join('\n')

  return `
<section class="checked-lead-form" data-form-key="${escapeAttr(formKey)}">
  <style>
    .checked-lead-form { margin: 24px 0; padding: 20px; border: 1px solid #E7E6E2; border-radius: 12px; font-family: inherit; }
    .checked-lead-form h3 { margin: 0 0 12px; font-size: 18px; letter-spacing: -0.01em; color: #18181B; }
    .checked-lead-form .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .checked-lead-form label { font-size: 12px; font-weight: 600; color: #52525B; }
    .checked-lead-form input, .checked-lead-form textarea {
      width: 100%; box-sizing: border-box;
      padding: 10px 12px; font: inherit; font-size: 14px;
      border: 1px solid #E7E6E2; border-radius: 8px; background: #fff; color: #18181B;
    }
    .checked-lead-form textarea { min-height: 100px; resize: vertical; }
    .checked-lead-form button {
      display: inline-block; padding: 10px 16px; font: inherit; font-size: 14px; font-weight: 600;
      border: 0; border-radius: 10px; background: #18181B; color: #FAF9F6; cursor: pointer;
    }
    .checked-lead-form .thanks {
      padding: 16px; border-radius: 8px; background: #ECFDF5; color: #047857; font-weight: 600;
    }
  </style>
  <div id="${formBlockId}">
    <h3>${escapeHtml(title)}</h3>
    <form method="POST" action="?">
      <input type="hidden" name="_form" value="${escapeAttr(formKey)}" />
      ${fieldHTML}
      <button type="submit">${escapeHtml(buttonLabel)}</button>
    </form>
  </div>
  <div id="${thanksBlockId}" class="thanks" style="display:none;">
    ${escapeHtml(thanksMsg)}
  </div>
  <script>
    (function () {
      try {
        var q = new URLSearchParams(window.location.search);
        if (q.get('lead-form-submitted') === ${JSON.stringify(formKey)}) {
          var f = document.getElementById(${JSON.stringify(formBlockId)});
          var t = document.getElementById(${JSON.stringify(thanksBlockId)});
          if (f) f.style.display = 'none';
          if (t) t.style.display = 'block';
        }
      } catch (e) { /* progressive enhancement — noop on failure */ }
    })();
  </script>
</section>
  `.trim()
}

function renderField(formKey: string, f: FieldSpec): string {
  const id = `lf-${cssId(formKey)}-${cssId(f.key)}`
  if (f.type === 'textarea') {
    return `<div class="field">
      <label for="${id}">${escapeHtml(f.label)}</label>
      <textarea id="${id}" name="${escapeAttr(f.key)}" placeholder="${escapeAttr(f.placeholder)}"${f.required ? ' required' : ''}></textarea>
    </div>`
  }
  return `<div class="field">
    <label for="${id}">${escapeHtml(f.label)}</label>
    <input id="${id}" name="${escapeAttr(f.key)}" type="${escapeAttr(f.type)}" placeholder="${escapeAttr(f.placeholder)}"${f.required ? ' required' : ''} />
  </div>`
}

function cssId(s: string): string {
  return s.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}
