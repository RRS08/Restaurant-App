'use client'

// ----------------------------------------------------------------
// SeedSwitcherCard — dev-only demo seed switcher.
//
// Lists every concept (taqueria, mariscos, …) the system knows
// about, shows which is installed, which is active, and gives the
// dev account three actions per row:
//
//   Install / Uninstall   — adds or removes that concept's menu +
//                            inventory + recipes from the DB
//   Activate / Deactivate — flips restaurants.active_seed_concept,
//                            which is what the POS / Menu /
//                            Inventory queries filter on
//
// Plus a one-time "Tag current data as test_seed" button — used
// once on a brand-new dev account so the existing untagged
// menu/inventory items get an explicit concept_key, which means
// they hide cleanly when a different seed is active.
//
// All actions go through app/actions/seed.ts which enforces
// isDevEmail server-side — this card is just the surface.
// ----------------------------------------------------------------

import { useTransition, useState } from 'react'
import {
  setActiveSeed,
  installSeed,
  uninstallSeed,
  tagCurrentDataAs,
} from '@/app/actions/seed'

export interface ConceptRow {
  key: string
  labelEn: string
  labelEs: string
  installed: boolean
  // Count of menu items currently in the DB for this concept —
  // helps the dev see if a partial install happened.
  itemCount: number
  // True for ad-hoc buckets (test_seed) that the user populated
  // via "Tag current data as test_seed" rather than via the
  // pre-canned Install path. We hide Install / Uninstall on
  // those rows — Install is meaningless (there's no canned data)
  // and Uninstall would delete the user's actual test menu.
  adHoc?: boolean
}

interface Props {
  activeSeed: string | null
  installedConcepts: ConceptRow[]
  plannedConcepts: Array<{ key: string; labelEn: string }>
}

export default function SeedSwitcherCard({
  activeSeed,
  installedConcepts,
  plannedConcepts,
}: Props) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const run = (key: string, fn: () => Promise<{ error?: string; ok?: boolean }>) => {
    setError(null)
    setBusyKey(key)
    startTransition(async () => {
      const res = await fn()
      if (res?.error) setError(res.error)
      setBusyKey(null)
    })
  }

  const isActive = (k: string) => activeSeed === k

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700">
          Demo Seeds
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-600">
          Dev only
        </p>
      </div>
      <p className="mt-1.5 text-base font-semibold text-gray-900">
        Shape the demo to the lead in front of you.
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
        Each concept loads its own menu + inventory + recipes. Activate one and the POS,
        Menu, and Inventory pages filter to only what that concept needs — the others
        stay in the DB but stop rendering. Switching is one click. Nothing gets deleted
        until you explicitly Uninstall.
      </p>

      {error && (
        <p className="mt-3 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Currently active line — clear answer to "what is showing
          right now?" The deactivate link clears the cookie so the
          next page renders only NULL items. */}
      <div className="mt-4 flex items-center gap-3 flex-wrap text-[13px]">
        <span className="text-gray-500">Active:</span>
        <span className="font-mono font-semibold text-gray-900">
          {activeSeed ?? 'none (untagged data only)'}
        </span>
        {activeSeed && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run('__deactivate__', () => setActiveSeed(null))}
            className="text-[12px] text-gray-500 hover:text-gray-900 underline underline-offset-2"
          >
            Deactivate
          </button>
        )}
      </div>

      {/* Installed / installable concepts */}
      <div className="mt-4 space-y-2">
        {installedConcepts.map((c) => {
          const busy = busyKey === c.key && pending
          const active = isActive(c.key)
          return (
            <div
              key={c.key}
              className={
                'flex items-center justify-between gap-3 px-3 py-2 rounded-lg border ' +
                (active
                  ? 'border-amber-400 bg-white shadow-sm'
                  : 'border-gray-200 bg-white')
              }
            >
              <div className="flex items-center gap-3 min-w-0">
                {active && <span className="w-2 h-2 rounded-full bg-amber-500" />}
                <span className="text-sm font-semibold text-gray-900">
                  {c.labelEn}
                </span>
                {c.installed ? (
                  <span className="text-[11px] font-mono text-gray-400">
                    {c.itemCount} items
                  </span>
                ) : (
                  <span className="text-[11px] font-mono text-gray-400">not installed</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!c.installed && !c.adHoc && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(c.key, () => installSeed(c.key))}
                    className="text-xs font-medium px-3 py-1.5 rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-60"
                  >
                    {busy ? 'Installing…' : 'Install'}
                  </button>
                )}
                {c.installed && !active && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(c.key, () => setActiveSeed(c.key))}
                    className="text-xs font-medium px-3 py-1.5 rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-60"
                  >
                    {busy ? '…' : 'Activate'}
                  </button>
                )}
                {c.installed && active && (
                  <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-amber-700">
                    Active
                  </span>
                )}
                {c.installed && !c.adHoc && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Uninstall ${c.labelEn}? This deletes its menu + inventory rows for this restaurant.`)) {
                        run(c.key, () => uninstallSeed(c.key))
                      }
                    }}
                    className="text-xs text-gray-500 hover:text-red-700 disabled:opacity-60"
                  >
                    Uninstall
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {/* Planned but not yet seeded concepts. Visible so the
            dev knows what's coming; install button is greyed. */}
        {plannedConcepts.map((c) => (
          <div
            key={c.key}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-dashed border-gray-200 bg-gray-50/40"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-gray-500">{c.labelEn}</span>
              <span className="text-[11px] font-mono text-gray-400">no seed data yet</span>
            </div>
            <span className="text-[11px] text-gray-400 italic">coming soon</span>
          </div>
        ))}
      </div>

      {/* One-time helper: tag current untagged menu/inventory rows
          as a concept so they hide cleanly when another seed is
          active. Without this, the dev's "test data" stays visible
          alongside whichever seed is on. */}
      <div className="mt-5 pt-4 border-t border-amber-200/50">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700 mb-2">
          One-time setup
        </p>
        <p className="text-[12px] text-gray-600 leading-relaxed mb-2">
          Tag whatever menu + inventory you already have in this restaurant as
          <span className="font-mono"> test_seed</span>. Run once after you first install
          a new concept, so your old test data hides when you activate that concept.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (confirm('Tag all untagged menu items + categories + inventory in this restaurant as test_seed?')) {
              run('__tag__', () => tagCurrentDataAs('test_seed'))
            }
          }}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          Tag current data as test_seed
        </button>
      </div>
    </section>
  )
}
