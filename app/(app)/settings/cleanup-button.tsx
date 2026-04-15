'use client'

import { useState } from 'react'
import { cleanupDuplicateInventoryItems, runInventoryIntegrityChecks } from '@/app/actions/inventory-cleanup'
import { clearAllEmployees, resetStaffingSetup } from '@/app/actions/staffing'

export default function CleanupButton() {
  const [mergeRunning, setMergeRunning] = useState(false)
  const [mergeResult, setMergeResult] = useState<{
    error: string | null; merged: number; message?: string; details?: string[]
  } | null>(null)

  const [checkRunning, setCheckRunning] = useState(false)
  const [checkResult, setCheckResult] = useState<{
    error: string | null; issues: { type: string; category: string; message: string }[]
  } | null>(null)

  const runMerge = async () => {
    setMergeRunning(true); setMergeResult(null)
    const res = await cleanupDuplicateInventoryItems()
    setMergeResult(res); setMergeRunning(false)
  }

  const runChecks = async () => {
    setCheckRunning(true); setCheckResult(null)
    const res = await runInventoryIntegrityChecks()
    setCheckResult(res); setCheckRunning(false)
  }

  return (
    <div className="space-y-6">

      {/* Merge duplicates */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Merge duplicate inventory items</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Finds items with the same name, reassigns linked records, and removes extras.
            </p>
          </div>
          <button type="button" onClick={runMerge} disabled={mergeRunning}
            className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white
                       hover:bg-gray-800 disabled:opacity-60 transition-colors">
            {mergeRunning ? 'Running…' : 'Merge duplicates'}
          </button>
        </div>
        {mergeResult && (
          <div className="mt-3">
            {mergeResult.error
              ? <p className="text-xs text-red-600">{mergeResult.error}</p>
              : <p className="text-xs text-green-600">{mergeResult.message}</p>}
            {mergeResult.details?.map((d, i) => (
              <p key={i} className="text-[10px] text-gray-500 mt-0.5">{d}</p>
            ))}
          </div>
        )}
      </div>

      {/* Integrity checks */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Run integrity checks</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Scans for orphaned records, unit mismatches, archived items in recipes, and more.
            </p>
          </div>
          <button type="button" onClick={runChecks} disabled={checkRunning}
            className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-700
                       hover:bg-gray-50 disabled:opacity-60 transition-colors">
            {checkRunning ? 'Scanning…' : 'Run checks'}
          </button>
        </div>
        {checkResult && (
          <div className="mt-3">
            {checkResult.error
              ? <p className="text-xs text-red-600">{checkResult.error}</p>
              : checkResult.issues.length === 0
                ? <p className="text-xs text-green-600">All clear — no issues found.</p>
                : (
                  <div className="space-y-1.5">
                    {checkResult.issues.map((issue, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                          issue.type === 'auto_fixed' ? 'bg-green-500' : 'bg-amber-400'
                        }`} />
                        <div>
                          <p className="text-xs text-gray-700">{issue.message}</p>
                          <p className="text-[10px] text-gray-400">{issue.category} · {issue.type === 'auto_fixed' ? 'Auto-fixed' : 'Needs review'}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
          </div>
        )}
      </div>

      {/* Clear employees */}
      <ClearEmployeesButton />

      {/* Reset staffing setup */}
      <ResetStaffingButton />

    </div>
  )
}

function ResetStaffingButton() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ error: string | null; message?: string } | null>(null)

  const run = async () => {
    setRunning(true); setResult(null)
    const res = await resetStaffingSetup()
    setResult(res); setRunning(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">Reset staffing setup</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Wipes staffing configuration, shift structure, shifts, and archives employees. Makes Staffing show the onboarding wizard again.
          </p>
        </div>
        <button type="button" onClick={run} disabled={running}
          className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 text-red-600
                     hover:bg-red-50 disabled:opacity-60 transition-colors">
          {running ? 'Resetting…' : 'Reset setup'}
        </button>
      </div>
      {result && (
        <div className="mt-3">
          {result.error ? <p className="text-xs text-red-600">{result.error}</p> : <p className="text-xs text-green-600">{result.message}</p>}
        </div>
      )}
    </div>
  )
}

function ClearEmployeesButton() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ error: string | null; message?: string } | null>(null)

  const run = async () => {
    setRunning(true); setResult(null)
    const res = await clearAllEmployees()
    setResult(res); setRunning(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">Clear employees (testing)</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Archives all employees and removes their shifts. Preserves staffing setup and shift structure.
          </p>
        </div>
        <button type="button" onClick={run} disabled={running}
          className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 text-red-600
                     hover:bg-red-50 disabled:opacity-60 transition-colors">
          {running ? 'Clearing…' : 'Clear employees'}
        </button>
      </div>
      {result && (
        <div className="mt-3">
          {result.error ? <p className="text-xs text-red-600">{result.error}</p> : <p className="text-xs text-green-600">{result.message}</p>}
        </div>
      )}
    </div>
  )
}
