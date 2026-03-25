import type { SupabaseClient } from '@supabase/supabase-js'

export async function upsertExpoPushToken(
  supabase: SupabaseClient,
  expoPushToken: string,
  platform: string | null,
) {
  const { data: user } = await supabase.auth.getUser()
  const userId = user.user?.id
  if (!userId) return

  await supabase.from('user_push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: expoPushToken,
      platform,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,expo_push_token' },
  )
}

export async function deleteAllPushTokensForUser(supabase: SupabaseClient) {
  const { data: user } = await supabase.auth.getUser()
  const userId = user.user?.id
  if (!userId) return

  await supabase.from('user_push_tokens').delete().eq('user_id', userId)
}
