import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// ----------------------------------------------------------------
// cn() — class name utility
//
// This is the same helper that shadcn/ui uses internally, so when
// you install shadcn components later they'll use this same file.
//
// What it does:
//   - clsx() lets you write conditional class names cleanly:
//       cn('px-4', isActive && 'bg-blue-500', 'text-sm')
//   - twMerge() resolves Tailwind class conflicts so the last one wins:
//       cn('px-4 px-6')  →  'px-6'   (not both, which would be a bug)
//
// Usage example:
//   <div className={cn('base-class', isActive && 'active-class')} />
// ----------------------------------------------------------------
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
