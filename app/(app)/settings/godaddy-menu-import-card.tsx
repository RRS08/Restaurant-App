'use client'

// ----------------------------------------------------------------
// GoDaddyMenuImportCard — owner-facing UI for the godaddy_csv adapter
// on the MENU side.
//
// Same one-shot upload shape as the sales card sibling: pick a .csv
// exported from the GoDaddy Commerce dashboard (products / catalog
// export), pick a target location + channel, submit. The backing
// action `importGodaddyCsvMenu` reuses the shared menu ingest
// pipeline so:
//
//   • upsert keys on (source, external item id) — re-uploads
//     UPDATE rows in place instead of duplicating them.
//   • categories + items land tagged with the channel-specific
//     provider (godaddy_pos / godaddy_online) so a future live
//     GoDaddy API menu sync joins the same stream.
//
// Owner-gated server-side; non-owners see the UI but the action
// refuses (still surface a clean error to keep the failure mode
// friendly). File contents read on the client into a hidden
// textarea, same pattern as the sales card and the same MAX_IMPORT
// ceiling in validateImportInput.
// ----------------------------------------------------------------

import { useActionState, useRef, useState } from 'react'
import { importGodaddyCsvMenu } from '@/app/actions/pos-import'

interface Location { id: string; name: string }
interface Props { locations: Location[] }

type Result = { error: string } | { ok: true; message: string }

export default function GoDaddyMenuImportCard({ locations }: Props) {
  const [state, action, pending] = useActionState<Result | null, FormData>(
    importGodaddyCsvMenu,
    null,
  )

  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState(false)
  // Client-side failures surfaced inline — never `alert()`, never
  // swallowed, so the button can't appear to do nothing.
  const [clientError, setClientError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    // Capture the form element SYNCHRONOUSLY — React nulls
    // SyntheticEvent.currentTarget as soon as this handler yields at
    // its first `await`, so reading it afterwards gives null and
    // `new FormData(null)` throws into an unhandled rejection that
    // React never surfaces (the button just does nothing).
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
      inputRef.current.value = text
      action(new FormData(form))
      // File selection preserved so a failed import can be retried in
      // one tap; re-importing is upsert/dedupe-safe.
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
          GoDaddy menu import
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          Upsert · re-run safe
        </p>
      </div>
      <p className="mt-1.5 text-base font-semibold text-gray-900">
        Import your menu from a GoDaddy export.
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600 max-w-prose">
        Upload a products / catalog CSV from the GoDaddy Commerce dashboard and pick the target
        location. Categories and items are matched by their external ID, so re-uploading the
        same file updates existing rows in place — nothing gets duplicated.
      </p>

      {locations.length === 0 ? (
        <p className="mt-4 text-[13px] text-red-700">
          No locations found. Add at least one location before importing.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
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
              {pending || reading ? 'Importing…' : 'Import menu'}
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
