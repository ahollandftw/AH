/**
 * Populate daily_hr_projections for all model variants (default, weighted arsenal, contact quality).
 * Run after deploy or when a date is missing — same work as POST /bdl/sync/projections.
 *
 * Usage:
 *   npm run projections --workspace=@kinetic/api
 *   npm run projections --workspace=@kinetic/api -- 2026-04-04
 *
 * Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BDL_API_KEY (and other vars hrEngine needs).
 */
import { runAndSaveProjections } from './hrEngine.js'

function todayET(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const arg = process.argv[2]
const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : todayET()

runAndSaveProjections(date)
  .then((r) => {
    console.log(`[runProjections] date=${date}`, r)
    process.exit(0)
  })
  .catch((e) => {
    console.error('[runProjections]', e)
    process.exit(1)
  })
