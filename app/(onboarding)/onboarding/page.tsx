'use client'

// ----------------------------------------------------------------
// Onboarding Page  →  /onboarding
//
// This page has two visual steps, but only ONE server action call.
// All the data is collected in React state first, then sent in one
// form submission when the user finishes step 2.
//
// Why one submission instead of two?
//   - Simpler: no cookies or URL params needed to pass restaurant_id
//     between two pages.
//   - Atomic: the restaurant, location, and owner role are all created
//     together. If something fails, the user just tries again — there's
//     no half-built restaurant left behind.
//
// Step 1: Restaurant name    (collected in React state)
// Step 2: Location details   (submitted along with step 1 data)
// ----------------------------------------------------------------

import { useState, useActionState } from 'react'
import { createRestaurantAndLocation } from '@/app/actions/onboarding'

// A small selectable card used by Step 3 (operating mode).
function ModeCard({ selected, onClick, title, desc }: {
  selected: boolean; onClick: () => void; title: string; desc: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border-2 p-4 transition-all ${
        selected
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <p className={`text-sm font-semibold ${selected ? 'text-blue-700' : 'text-gray-900'}`}>{title}</p>
      <p className="mt-1 text-xs text-gray-500 leading-relaxed">{desc}</p>
    </button>
  )
}

// A small visual "step indicator" component — shows which step you're on.
function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold
              ${i + 1 <= current
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-400'
              }`}
          >
            {i + 1}
          </div>
          {i < total - 1 && (
            <div className={`w-8 h-px ${i + 1 < current ? 'bg-blue-600' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

type OperatingMode = 'native_pos' | 'external_pos'

export default function OnboardingPage() {
  // Three steps: name → location → operating mode.
  const [step, setStep] = useState(1)

  const [restaurantName, setRestaurantName] = useState('')
  const [locationDraft, setLocationDraft] = useState<{
    name: string; address: string; timezone: string
  }>({ name: '', address: '', timezone: 'UTC' })
  const [operatingMode, setOperatingMode] = useState<OperatingMode | null>(null)

  // useActionState wires up the server action.
  // The form will call createRestaurantAndLocation when submitted.
  const [state, action, pending] = useActionState(createRestaurantAndLocation, null)

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Set up your restaurant</h1>
          <p className="mt-1 text-sm text-gray-500">This only takes a minute</p>
        </div>

        {/* Step indicator */}
        <div className="flex justify-center">
          <StepIndicator current={step} total={3} />
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">

          {/* ---- STEP 1: Restaurant name ---- */}
          {step === 1 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">
                What&apos;s your restaurant called?
              </h2>
              <p className="text-sm text-gray-500 mb-6">
                This is the name of your business.
              </p>

              {/* Step 1 is NOT a server form — it just updates local state.
                  We prevent default and move to step 2. */}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const input = (e.currentTarget.elements.namedItem('restaurant_name_step1') as HTMLInputElement)
                  if (input.value.trim()) {
                    setRestaurantName(input.value.trim())
                    setStep(2)
                  }
                }}
                className="space-y-5"
              >
                <div>
                  <label
                    htmlFor="restaurant_name_step1"
                    className="block text-sm font-medium text-gray-700 mb-1.5"
                  >
                    Restaurant name
                  </label>
                  <input
                    id="restaurant_name_step1"
                    name="restaurant_name_step1"
                    type="text"
                    required
                    defaultValue={restaurantName}
                    autoFocus
                    placeholder="e.g. Mario's Pizza"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                               placeholder:text-gray-400
                               focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold
                             text-white hover:bg-blue-700 transition-colors"
                >
                  Continue
                </button>
              </form>
            </div>
          )}

          {/* ---- STEP 2: First location (local state only) ---- */}
          {step === 2 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">
                Where is your first location?
              </h2>
              <p className="text-sm text-gray-500 mb-6">
                You can add more locations later from your settings.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const el = e.currentTarget.elements
                  const name = (el.namedItem('location_name') as HTMLInputElement).value.trim()
                  const address = (el.namedItem('address') as HTMLInputElement).value.trim()
                  const timezone = (el.namedItem('timezone') as HTMLSelectElement).value
                  if (name) {
                    setLocationDraft({ name, address, timezone })
                    setStep(3)
                  }
                }}
                className="space-y-5"
              >
                <div>
                  <label htmlFor="location_name" className="block text-sm font-medium text-gray-700 mb-1.5">Location name</label>
                  <input
                    id="location_name" name="location_name" type="text" required autoFocus
                    defaultValue={locationDraft.name}
                    placeholder="e.g. Main Street, Downtown, Airport"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-gray-700 mb-1.5">
                    Address <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    id="address" name="address" type="text"
                    defaultValue={locationDraft.address}
                    placeholder="123 Main Street, City"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 mb-1.5">Timezone</label>
                  <select
                    id="timezone" name="timezone"
                    defaultValue={locationDraft.timezone}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">Eastern Time (US & Canada)</option>
                    <option value="America/Chicago">Central Time (US & Canada)</option>
                    <option value="America/Denver">Mountain Time (US & Canada)</option>
                    <option value="America/Los_Angeles">Pacific Time (US & Canada)</option>
                    <option value="Europe/London">London</option>
                    <option value="Europe/Paris">Paris / Berlin / Rome</option>
                    <option value="Asia/Tokyo">Tokyo</option>
                    <option value="Australia/Sydney">Sydney</option>
                  </select>
                </div>

                <div className="flex gap-3 pt-1">
                  <button type="button" onClick={() => setStep(1)}
                    className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                    Back
                  </button>
                  <button type="submit"
                    className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors">
                    Continue
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ---- STEP 3: Operating mode + final submit ---- */}
          {step === 3 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">
                How are sales captured?
              </h2>
              <p className="text-sm text-gray-500 mb-6">
                You can change this later in settings.
              </p>

              <form action={action} className="space-y-5">
                <input type="hidden" name="restaurant_name" value={restaurantName} />
                <input type="hidden" name="location_name"   value={locationDraft.name} />
                <input type="hidden" name="address"         value={locationDraft.address} />
                <input type="hidden" name="timezone"        value={locationDraft.timezone} />
                <input type="hidden" name="operating_mode"  value={operatingMode ?? ''} />

                <div className="grid gap-3">
                  <ModeCard
                    selected={operatingMode === 'native_pos'}
                    onClick={() => setOperatingMode('native_pos')}
                    title="Native POS"
                    desc="Ring up sales with the built-in POS. Full control over items, prices, and inventory tracking."
                  />
                  <ModeCard
                    selected={operatingMode === 'external_pos'}
                    onClick={() => setOperatingMode('external_pos')}
                    title="External POS"
                    desc="You use another POS (Square, Toast, etc.). Sales will sync in when integrations are available."
                  />
                </div>

                {state?.error && (
                  <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                    <p className="text-sm text-red-700">{state.error}</p>
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <button type="button" onClick={() => setStep(2)}
                    className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                    Back
                  </button>
                  <button type="submit" disabled={pending || !operatingMode}
                    className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
                    {pending ? 'Creating…' : 'Finish setup'}
                  </button>
                </div>
              </form>
            </div>
          )}

        </div>

        {/* Context note */}
        <p className="mt-6 text-center text-xs text-gray-400">
          You can edit all of this later from your restaurant settings.
        </p>

      </div>
    </div>
  )
}
