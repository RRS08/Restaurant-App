'use client'

// Tiny client wrapper — the report page is otherwise a pure server
// component. Sizing + palette match the toolbar's CSV button next
// to it so the two land as a matched CTA pair.

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      style={{
        border: 0, background: '#18181B', color: '#FAF9F6',
        borderRadius: 10, height: 34, padding: '0 16px',
        fontSize: 13, fontWeight: 600, cursor: 'pointer',
        font: 'inherit',
      }}
    >
      Print
    </button>
  )
}
