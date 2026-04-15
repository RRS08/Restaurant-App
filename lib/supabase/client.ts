import { createBrowserClient } from '@supabase/ssr'

// ----------------------------------------------------------------
// Browser Supabase Client
//
// Use this in Client Components — files that have 'use client' at
// the top. The browser client runs in the user's browser.
//
// It uses the public ANON key, which is safe to expose.
// Your Row Level Security (RLS) policies in the database are what
// actually protect the data — not keeping this key secret.
// ----------------------------------------------------------------
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
