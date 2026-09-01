'use client'

// Tiny client wrapper — the report page is otherwise a pure server
// component. Kept in its own file so the report page can stay a
// static server render and only this one button leaves the server
// boundary.

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      style={{
        border: '1px solid #18181B', background: '#18181B', color: '#FAF9F6',
        borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 500,
        cursor: 'pointer', font: 'inherit',
      }}
    >
      Print / Save as PDF
    </button>
  )
}
