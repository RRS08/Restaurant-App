'use client'

// ----------------------------------------------------------------
// GoDaddySalesImportCard — dev-facing UI for the godaddy_csv adapter.
//
// One-shot upload path: pick a .csv exported from the GoDaddy Commerce
// dashboard (POS/Poynt transactions export OR the online storefront
// orders export), pick a target location + channel, submit. The
// backing action (importGodaddyCsvOrders) reuses the same shared
// ingest pipeline as every other CSV/API import, so:
//
//   • dedupe by (provider, external order id) — re-uploading the
//     same export is safe; nothing double-counts.
//   • rows land under source='external_pos', external_provider =
//     godaddy_pos OR godaddy_online (chosen via the Channel radio),
//     so a future live GoDaddy API sync joins the same stream.
//
// Owner-gated server-side. Non-owners get a friendly error.
//
// UI shape matches the other dev-tools cards (amber-tinted section,
// eyebrow + title + body copy, quiet form). File contents are read
// on the client into a hidden `<textarea name="input">` so the
// server action receives the same string shape it does for the
// paste-based `importCsvOrders` flow — no server-side multipart
// parsing needed, and the char cap in validateImportInput still
// applies as a hard ceiling.
// ----------------------------------------------------------------

import { useActionState, useRef, useState } from 'react'
import { importGodaddyCsvOrders } from '@/app/actions/pos-import'

interface Location { id: string; name: string }
interface Props { locations: Location[] }

// Match the action's discriminated-union return so useActionState's
// generic doesn't widen ok/error incompatibly. Kept in sync with the
// server-side `Result` definition in pos-import.ts.
type Result = { error: string } | { ok: true; message: string }

export default function GoDaddySalesImportCard({ locations }: Props) {
  const [state, action, pending] = useActionState<Result | null, FormData>(
    importGodaddyCsvOrders,
    null,
  )

  // File the user picked — held in component state so we can show
  // its name (and size) before submit and so the form action can
  // read the text on submit without another user interaction.
  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Read the picked file into text and stash it in the hidden
  // textarea. Called on submit; guards against submit-with-no-file
  // and against unreadable files (non-UTF8, gigantic). We drop the
  // browser's async File.text() into the textarea and let the form
  // action serialize it into the FormData normally.
  const readIntoTextarea = async (): Promise<boolean> => {
    if (!file) return false
    if (!inputRef.current) return false
    setReading(true)
    try {
      const text = await file.text()
      inputRef.current.value = text
      return true
    } catch {
      return false
    } finally {
      setReading(false)
    }
  }

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    // Read the file BEFORE the form submits so `input` carries text.
    // If nothing selected, block with a soft error — no exception.
    if (!file) {
      e.preventDefault()
      alert('Pick a CSV file first.')
      return
    }
    e.preventDefault()
    const ok = await readIntoTextarea()
    if (!ok) {
      alert('Could not read that file. Is it a plain-text CSV?')
      return
    }
    // Manually submit the form now that hidden input is populated.
    const fd = new FormData(e.currentTarget)
    action(fd)
    // Clear the file input so a follow-up import can start fresh.
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const disabled = pending || reading || !file || locations.length === 0

  return (
    <section className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
          GoDaddy sales import
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          One-shot · dedupe-safe
        </p>
      </div>
      <p className="mt-1.5 text-base font-semibold text-gray-900">
        Import your sales from a GoDaddy export.
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600 max-w-prose">
        Upload a CSV from the GoDaddy Commerce dashboard — either the POS/Poynt transactions
        export or the online storefront orders export — and pick the target location. Rows land
        under the matching provider tag so a future live GoDaddy API sync joins the same stream.
        Re-uploading the same file is safe: duplicates are skipped by <span className="font-mono text-xs">(provider, order id)</span>.
      </p>

      {locations.length === 0 ? (
        <p className="mt-4 text-[13px] text-red-700">
          No locations found. Add at least one location before importing.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          {/* File input */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">
              File
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,application/vnd.ms-excel"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-[13px] text-gray-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:font-semibold file:bg-gray-900 file:text-white hover:file:bg-gray-800 file:cursor-pointer"
            />
            {file && (
              <p className="mt-1 text-[11px] text-gray-500 font-mono">
                {file.name} · {formatBytes(file.size)}
              </p>
            )}
          </div>

          {/* Location + channel side-by-side on wide, stacked on narrow */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">
                Location
              </label>
              <select
                name="location_id"
                required
                defaultValue={locations[0]?.id ?? ''}
                className="w-full h-9 rounded-md border border-gray-200 bg-white px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">
                Channel
              </label>
              <select
                name="channel"
                defaultValue="pos"
                className="w-full h-9 rounded-md border border-gray-200 bg-white px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
              >
                <option value="pos">POS (in-store / Poynt)</option>
                <option value="online">Online storefront</option>
              </select>
            </div>
          </div>

          {/* Hidden textarea receives the file's text on submit. Kept
              off-screen (aria-hidden + tabIndex=-1) instead of type=hidden
              so we can populate it with the multi-line CSV body without
              worrying about newline handling. */}
          <textarea
            ref={inputRef}
            name="input"
            defaultValue=""
            aria-hidden="true"
            tabIndex={-1}
            className="sr-only"
          />

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={disabled}
              className="h-9 px-4 rounded-md bg-gray-900 text-white text-[13px] font-semibold hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {pending || reading ? 'Importing…' : 'Import sales'}
            </button>
            {state && 'ok' in state && (
              <p className="text-[12px] text-emerald-700">{state.message}</p>
            )}
            {state && 'error' in state && (
              <p className="text-[12px] text-red-700">{state.error}</p>
            )}
          </div>
        </form>
      )}
    </section>
  )
}

// Tiny KB/MB helper — no need for a full byte formatter here.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
