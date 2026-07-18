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
  // Client-side failures (no file, unreadable file, form not ready).
  // Rendered inline next to the server result — never `alert()`, and
  // never swallowed, so the button can't appear to do nothing.
  const [clientError, setClientError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    // Capture the form element SYNCHRONOUSLY.
    //
    // React nulls SyntheticEvent.currentTarget the moment this handler
    // yields at its first `await` (react-dom sets `event.currentTarget
    // = null` right after the listener returns). Reading it after the
    // await would give null, and `new FormData(null)` throws — inside
    // an async handler that becomes an unhandled rejection React does
    // not surface, so the button silently does nothing. This was the
    // bug: capture first, use later.
    const form = e.currentTarget

    setClientError(null)

    if (!file) {
      setClientError('Pick a CSV file first.')
      return
    }
    if (!inputRef.current) {
      setClientError('Form is not ready — reload the page and try again.')
      return
    }

    setReading(true)
    try {
      const text = await file.text()
      if (!text.trim()) {
        setClientError('That file is empty.')
        return
      }
      // Stash the CSV body in the hidden textarea so the action
      // receives the same string shape as the paste-based flow.
      inputRef.current.value = text
      action(new FormData(form))
      // The file selection is intentionally preserved so a failed
      // import (e.g. unrecognized headers) can be retried in one tap.
      // Re-importing is dedupe-safe, so keeping it is harmless.
    } catch (err) {
      setClientError(
        err instanceof Error
          ? `Could not read that file: ${err.message}`
          : 'Could not read that file. Is it a plain-text CSV?',
      )
    } finally {
      setReading(false)
    }
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
            {clientError && (
              <p className="text-[12px] text-red-700">{clientError}</p>
            )}
            {!clientError && state && 'ok' in state && (
              <p className="text-[12px] text-emerald-700">{state.message}</p>
            )}
            {!clientError && state && 'error' in state && (
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
