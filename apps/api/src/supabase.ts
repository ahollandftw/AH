import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'

export function getServiceClient() {
  return createClient(config.supabaseUrl(), config.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
