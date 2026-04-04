/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_API_BASE_URL?: string
  /** Client-safe API origin (alias for production when VITE_API_BASE_URL is unset) */
  readonly VITE_PUBLIC_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
