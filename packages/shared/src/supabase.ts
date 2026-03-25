import { createClient } from '@supabase/supabase-js'
import type { SupabaseClientOptions } from '@supabase/supabase-js'

/**
 * Single Supabase client factory for web and native.
 * On React Native, pass `auth.storage` (e.g. AsyncStorage) via `options`.
 */
export function createSupabaseClient(
  url: string,
  anonKey: string,
  options?: SupabaseClientOptions<'public'>,
) {
  const merged: SupabaseClientOptions<'public'> = {
    ...options,
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      ...(options?.auth ?? {}),
    },
  }
  return createClient(url, anonKey, merged)
}
