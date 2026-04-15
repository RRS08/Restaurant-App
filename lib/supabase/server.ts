import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// ----------------------------------------------------------------
// Server Supabase Client
//
// Use this in:
//   - Server Components (layouts, pages that don't have 'use client')
//   - Server Actions ('use server' files)
//   - Route Handlers (app/api/**/route.ts)
//
// It reads and writes cookies to keep the user's session alive.
// `cookies()` from 'next/headers' is only available on the server,
// which is why we have a separate client for browser vs. server.
//
// This function is async because cookies() returns a Promise
// in Next.js 16+.
// ----------------------------------------------------------------
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // Read all cookies from the incoming request.
        getAll() {
          return cookieStore.getAll()
        },
        // Write cookies back to the response.
        // This is how Supabase refreshes your session token automatically.
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // This error occurs when setAll is called from a Server Component
            // (not a Server Action). It's safe to ignore — the proxy.ts file
            // handles session refreshing at the request level.
          }
        },
      },
    }
  )
}
