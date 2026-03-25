import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..', '..')
dotenv.config({ path: path.join(root, '.env') })
dotenv.config({ path: path.join(root, '.env.local') })

function req(name: string): string {
  const v = process.env[name]
  if (!v?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return v.trim()
}

export const config = {
  supabaseUrl: () => req('SUPABASE_URL'),
  supabaseServiceRoleKey: () => req('SUPABASE_SERVICE_ROLE_KEY'),
  stripeSecretKey: () => req('STRIPE_SECRET_KEY'),
  stripePriceLookupKey: () => req('STRIPE_PRICE_LOOKUP_KEY'),
  appUrl: () => process.env.PUBLIC_APP_URL?.trim() || 'http://localhost:5173',
  port: Number(process.env.PORT ?? '3001'),
  /** Approximate season start (YYYY-MM-DD). Override with SEASON_START. */
  seasonStart: () => process.env.SEASON_START ?? `${new Date().getFullYear()}-03-15`,
}
