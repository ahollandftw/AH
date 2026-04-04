/**
 * Base URL for the Express API (BDL routes, projections, etc.).
 * Prefer VITE_API_BASE_URL in production; VITE_PUBLIC_API_URL is an alias some hosts use.
 * Empty string = same-origin relative paths (works with Vite dev proxy for /bdl).
 */
export function resolveApiBaseUrl(): string {
  const a = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (a) return a.replace(/\/$/, '')
  const b = (import.meta.env.VITE_PUBLIC_API_URL as string | undefined)?.trim()
  if (b) return b.replace(/\/$/, '')
  return ''
}
