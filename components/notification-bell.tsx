'use client'

// ----------------------------------------------------------------
// Notification Bell
//
// A bell icon with a badge count. Clicking it opens a dropdown
// panel showing categorized alert details. This is a UI-only
// component — no backend notification system, no read/unread
// tracking. It simply renders the alerts passed as props.
//
// Used on the dashboard header to replace stacked warning banners.
// ----------------------------------------------------------------

import { useState, useRef, useEffect } from 'react'
import { Bell } from 'lucide-react'

export interface AlertItem {
  label: string
  type: 'critical' | 'warning' | 'info'
}

interface Props {
  alerts: AlertItem[]
}

export default function NotificationBell({ alerts }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const count = alerts.length
  const hasCritical = alerts.some((a) => a.type === 'critical')

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg
                   text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        aria-label={`${count} alert${count !== 1 ? 's' : ''}`}
      >
        <Bell className="w-[18px] h-[18px]" />
        {count > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full
                            flex items-center justify-center text-[10px] font-bold text-white px-1
                            ${hasCritical ? 'bg-red-500' : 'bg-amber-500'}`}>
            {count}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl border border-gray-200
                        shadow-lg z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-900">Alerts</p>
            <p className="text-xs text-gray-400">{count === 0 ? 'All clear' : `${count} item${count !== 1 ? 's' : ''} need attention`}</p>
          </div>

          {count === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-gray-400">No issues right now.</p>
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto divide-y divide-gray-50">
              {alerts.map((alert, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3">
                  <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                    alert.type === 'critical' ? 'bg-red-500'
                      : alert.type === 'warning' ? 'bg-amber-400'
                        : 'bg-gray-300'
                  }`} />
                  <p className="text-sm text-gray-700">{alert.label}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
