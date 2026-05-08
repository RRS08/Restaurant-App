'use client'

// ----------------------------------------------------------------
// ConnectBankButton — client wrapper around <PlaidLink/>.
//
// Boot-safety:
//   The button does NOT fetch a link_token on mount. Nothing Plaid
//   related runs until the user explicitly clicks Connect. That way
//   a page render never depends on Plaid env vars being present —
//   the app boots cleanly when Plaid is unconfigured.
//
// Duplicate-script safety:
//   `usePlaidLink` embeds Plaid's `link-initialize.js` the first
//   time it runs with a valid token. If that hook lived on the main
//   button component, every parent re-render (router.refresh after
//   a successful connection, React strict mode's dev double-mount,
//   etc.) could re-embed the script. To avoid that, the hook is
//   isolated inside <PlaidLinker/>, a tiny child that only mounts
//   when `linkToken !== null` and unmounts the moment Link closes.
//   One click = one mount = one script embed.
//
// Flow when configured:
//   1. User clicks Connect → createPlaidLinkToken() runs server-side.
//   2. Token is stashed in state. <PlaidLinker/> mounts with it.
//   3. PlaidLinker auto-opens Link the moment the hook reports
//      `ready`, then reports success/exit back up.
//   4. onSuccess → exchangePlaidPublicToken(public_token) →
//      router.refresh() so Settings re-renders. Token is cleared so
//      PlaidLinker unmounts.
//
// When NOT configured (`configured={false}`):
//   Render a disabled button + a short explanatory message. No
//   network calls, no hook work, no Plaid script touched.
// ----------------------------------------------------------------

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { createPlaidLinkToken, exchangePlaidPublicToken } from '@/app/actions/bank'

interface Props {
  configured: boolean
}

export function ConnectBankButton({ configured }: Props) {
  const router = useRouter()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isFetchingToken, setIsFetchingToken] = useState(false)

  const handleSuccess = useCallback(
    (publicToken: string) => {
      setError(null)
      setMessage('Exchanging token…')
      // Clear the token immediately so <PlaidLinker/> unmounts and
      // won't reinitialize Plaid when router.refresh re-renders us.
      setLinkToken(null)
      startTransition(async () => {
        const fd = new FormData()
        fd.set('public_token', publicToken)
        const res = await exchangePlaidPublicToken(null, fd)
        if (res && 'error' in res) {
          setError(res.error)
          setMessage(null)
        } else {
          setMessage(res?.message ?? 'Connected.')
          router.refresh()
        }
      })
    },
    [router]
  )

  const handleExit = useCallback(() => {
    // User closed Link without connecting. Drop the token so the
    // Plaid hook unmounts and a future click gets a fresh one.
    setLinkToken(null)
  }, [])

  const handleClick = useCallback(async () => {
    if (!configured || isFetchingToken || isPending || linkToken) return
    setError(null)
    setMessage(null)
    setIsFetchingToken(true)
    try {
      const res = await createPlaidLinkToken()
      if ('error' in res) {
        setError(res.error)
        return
      }
      setLinkToken(res.linkToken)
    } finally {
      setIsFetchingToken(false)
    }
  }, [configured, isFetchingToken, isPending, linkToken])

  if (!configured) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled
          className="inline-flex items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white opacity-50"
        >
          Connect bank
        </button>
        <p className="text-xs text-gray-500">
          Plaid is not configured yet. Set <code>PLAID_CLIENT_ID</code> and{' '}
          <code>PLAID_SECRET</code> in your environment to enable bank sync.
        </p>
      </div>
    )
  }

  const busy = isFetchingToken || isPending || linkToken !== null

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={handleClick}
        className="inline-flex items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {isFetchingToken
          ? 'Preparing…'
          : isPending
            ? 'Connecting…'
            : linkToken
              ? 'Opening…'
              : 'Connect bank'}
      </button>
      {message && <p className="text-sm text-gray-600">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {linkToken && (
        <PlaidLinker
          key={linkToken}
          token={linkToken}
          onSuccess={handleSuccess}
          onExit={handleExit}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// PlaidLinker — the ONLY component in the app that calls
// `usePlaidLink`. Mounted only while a link token is live, so the
// Plaid Link script is embedded exactly once per connect attempt.
// Renders nothing; its sole purpose is to own the hook lifecycle
// and pop the modal open as soon as it's ready.
// ----------------------------------------------------------------
interface PlaidLinkerProps {
  token: string
  onSuccess: (publicToken: string) => void
  onExit: () => void
}

function PlaidLinker({ token, onSuccess, onExit }: PlaidLinkerProps) {
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken) => onSuccess(publicToken),
    onExit: () => onExit(),
  })

  useEffect(() => {
    if (ready) open()
  }, [ready, open])

  return null
}
