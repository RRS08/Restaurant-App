// ----------------------------------------------------------------
// Shared import utilities.
//
// Small helpers that every file-based adapter (CSV, custom JSON,
// future XLSX, etc.) should use so their normalization stays
// byte-for-byte consistent. Keeping one authoritative `slug`
// implementation prevents "CSV slug = foo" / "JSON slug = foo-"
// drift where the same input produces different dedupe keys
// depending on which adapter parsed it.
// ----------------------------------------------------------------

/**
 * Deterministic slug: lowercase, trim, replace runs of non-alnum
 * with a single hyphen, then strip leading/trailing hyphens.
 * Empty string is a legitimate output for all-punctuation input.
 */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
