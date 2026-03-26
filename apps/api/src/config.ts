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
  stripeWebhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET?.trim() || '',
  stripeBasicMonthlyLookupKey: () => req('STRIPE_PRICE_LOOKUP_KEY_BASIC_MONTHLY'),
  stripePlusMonthlyLookupKey: () => req('STRIPE_PRICE_LOOKUP_KEY_PLUS_MONTHLY'),
  appUrl: () => process.env.PUBLIC_APP_URL?.trim() || 'http://localhost:5173',
  port: Number(process.env.PORT ?? '3001'),
  seasonStart: () => process.env.SEASON_START ?? `${new Date().getFullYear()}-03-15`,
  bdlApiKey: () => req('BDL_API_KEY'),
  resendApiKey: () => process.env.RESEND_API_KEY?.trim() || '',
  supportEmail: () => process.env.SUPPORT_EMAIL?.trim() || 'analytichustle.support@gmail.com',
  moderationSecret: () => process.env.WALL_MODERATION_SECRET?.trim() || '',
  publicApiUrl: () => process.env.PUBLIC_API_URL?.trim() || `http://localhost:${Number(process.env.PORT ?? '3001')}`,
}
