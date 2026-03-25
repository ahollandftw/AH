// Supabase Edge Function: send batched notifications via Expo Push API.
// Secrets (Dashboard → Edge Functions → Secrets):
//   CRON_SECRET           — required; send header Authorization: Bearer <CRON_SECRET>
//   EXPO_ACCESS_TOKEN     — optional; Expo account token for higher rate limits / production
//
// Deploy: supabase functions deploy send-expo-push --no-verify-jwt
// Invoke: POST .../functions/v1/send-expo-push  (see comment at bottom)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

const EXPO_URL = 'https://exp.host/--/api/v2/push/send'

type Body = {
  title?: string
  body?: string
  data?: Record<string, unknown>
  /** broadcast = all users with alerts + tokens; watchlist = users who watch this Statcast player */
  mode?: 'broadcast' | 'watchlist'
  /** Statcast player id (e.g. "660271") — preferred */
  player_stat_id?: string
  /** Legacy: resolve via players.slug */
  player_slug?: string
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers':
          'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  const cronSecret = Deno.env.get('CRON_SECRET')
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!cronSecret || token !== cronSecret) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing Supabase env' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let payload: Body = {}
  try {
    if (req.method === 'POST' && req.headers.get('content-type')?.includes('json')) {
      payload = (await req.json()) as Body
    }
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  const title = payload.title ?? 'AnalyticHustle'
  const body = payload.body ?? 'Alert'
  const mode = payload.mode ?? 'broadcast'
  const extraData = payload.data ?? {}

  let tokens: string[] = []

  if (mode === 'watchlist') {
    const statId = payload.player_stat_id?.trim()
    const slug = payload.player_slug?.trim()
    if (statId) {
      const { data, error } = await supabase.rpc('get_expo_push_tokens_for_watchlist_player', {
        p_stat_player_id: statId,
      })
      if (error) return jsonResponse({ error: error.message }, 500)
      tokens = (data as string[]) ?? []
    } else if (slug) {
      const { data, error } = await supabase.rpc('get_expo_push_tokens_for_watchlist_player_by_slug', {
        p_slug: slug,
      })
      if (error) return jsonResponse({ error: error.message }, 500)
      tokens = (data as string[]) ?? []
    } else {
      return jsonResponse(
        { error: 'watchlist mode requires player_stat_id or player_slug' },
        400,
      )
    }
  } else {
    const { data, error } = await supabase.rpc('get_expo_push_tokens_broadcast')
    if (error) return jsonResponse({ error: error.message }, 500)
    tokens = (data as string[]) ?? []
  }

  tokens = [...new Set(tokens)].filter((t) => typeof t === 'string' && t.length > 10)

  if (tokens.length === 0) {
    return jsonResponse({
      ok: true,
      sent: 0,
      message: 'No Expo tokens matched (alerts off, no devices, or empty watchlist).',
    })
  }

  const expoAccess = Deno.env.get('EXPO_ACCESS_TOKEN')
  const messages = tokens.map((to) => ({
    to,
    title,
    body,
    sound: 'default',
    priority: 'high',
    channelId: 'hr-alerts',
    data: { ...extraData, mode },
  }))

  const results: unknown[] = []
  for (const batch of chunk(messages, 100)) {
    const res = await fetch(EXPO_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
        ...(expoAccess ? { Authorization: `Bearer ${expoAccess}` } : {}),
      },
      body: JSON.stringify(batch),
    })
    const json = await res.json().catch(() => ({ raw: 'non-json' }))
    results.push({ status: res.status, body: json })
  }

  return jsonResponse({
    ok: true,
    recipients: tokens.length,
    batches: results.length,
    expo: results,
  })
})

// Example (replace PROJECT_REF and CRON_SECRET):
// curl -s -X POST "https://PROJECT_REF.supabase.co/functions/v1/send-expo-push" \
//   -H "Authorization: Bearer CRON_SECRET" \
//   -H "Content-Type: application/json" \
//   -d '{"mode":"broadcast","title":"Test","body":"Hello from Edge"}'
