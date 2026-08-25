// ----------------------------------------------------------------
// /places — pick a workspace.
//
// Server component. The layout skips its usual redirect-when-no-
// active-place gate for this route (otherwise we'd bounce in
// circles) and this page renders a tile grid of every place the
// operator's restaurant owns. Clicking a tile POSTs the id to
// selectPlace() which sets the active_place_id cookie and lands
// the operator on /dashboard.
//
// Design mirrors Claude Design's places-picker canvas: soft-tile
// grid, generous padding, "PLACES" eyebrow, headline, and one
// "+ Add a place" tile that stays a visual placeholder for now.
// ----------------------------------------------------------------

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listPlacesForRestaurant } from '@/lib/places'
import { selectPlace } from '@/app/actions/places'
import { BrandMark } from '@/components/brand'

export const metadata = { title: 'Choose a place · Checked' }

export default async function PlacesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRole } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!userRole) redirect('/onboarding')

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('name')
    .eq('id', userRole.restaurant_id)
    .single()

  const places = await listPlacesForRestaurant(supabase, userRole.restaurant_id)

  const initials = (user.email ?? '?').slice(0, 2).toUpperCase()

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#FAF9F6' }}>
      {/* Top strip — brand mark + tenant name on the left, avatar
          on the right. Matches the picker canvas exactly so this
          page reads as a distinct pre-workspace surface. */}
      <div className="flex items-center justify-between px-7 py-5">
        <div className="flex items-center gap-2.5 min-w-0">
          <BrandMark size={28} variant="solid" className="rounded-md flex-shrink-0" />
          <span className="text-sm font-semibold text-zinc-900 truncate">
            {restaurant?.name ?? 'Checked'}
          </span>
        </div>
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-600">
          {initials}
        </span>
      </div>

      {/* Centered picker column. Vertical centering + max-width
          keeps the grid tight on wide monitors and readable on
          phones (grid drops to one column via responsive util). */}
      <div className="flex-1 flex flex-col justify-center px-6 sm:px-12 pb-12 pt-6">
        <div className="w-full max-w-[1320px] mx-auto">
          <div className="font-mono text-[12px] uppercase tracking-[0.16em] text-zinc-400 mb-3.5">
            PLACES
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-[44px] font-bold tracking-tight text-zinc-900 mb-2.5">
            Choose a place
          </h1>
          <p className="text-base sm:text-[17px] text-zinc-500 mb-11">
            Each place keeps its own sales, catalog, inventory and books.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {places.map((p) => (
              <form key={p.id} action={selectPlace}>
                <input type="hidden" name="place_id" value={p.id} />
                <button
                  type="submit"
                  className="w-full text-left bg-white border border-[#E7E6E2] rounded-2xl p-7 min-h-[240px] flex flex-col justify-between gap-6 cursor-pointer hover:border-[#C4C4C7] hover:shadow-[0_2px_8px_rgba(24,24,27,0.07)] transition-shadow"
                >
                  <span className="inline-flex items-center justify-center w-[60px] h-[60px] rounded-[15px] bg-[#F4F4F2] text-zinc-900 flex-shrink-0">
                    {p.kind === 'online' ? <OnlineGlyph /> : <RetailGlyph />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[22px] font-semibold tracking-tight">{p.name}</span>
                    <span className="block text-sm text-zinc-500 mt-1">
                      {p.kind === 'online' ? 'Online store' : 'Retail location'}
                    </span>
                  </span>
                  <span className="text-xl text-[#D6D5D1] self-end">›</span>
                </button>
              </form>
            ))}

            {/* Add-a-place placeholder — not wired yet. Dashed
                border makes its "coming soon" affordance obvious;
                cursor stays default so it doesn't feel broken.
                Adding a second retail location lands in a follow-up
                once we've decided on the invite/permissions story. */}
            <div
              className="border border-dashed border-[#D6D5D1] rounded-2xl p-7 min-h-[240px] flex items-center justify-center gap-2 text-zinc-500 text-[15px] font-medium select-none"
              aria-disabled="true"
              title="Coming soon"
            >
              + Add a place
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function OnlineGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3.5 9.5h17M3.5 14.5h17" />
    </svg>
  )
}

function RetailGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 21V10M20 21V10" />
      <path d="M2.5 10L5 3.5h14L21.5 10z" />
      <path d="M9 21v-6h6v6" />
      <path d="M2.5 21h19" />
    </svg>
  )
}
