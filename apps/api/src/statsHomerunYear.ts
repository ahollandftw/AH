import type { SupabaseClient } from '@supabase/supabase-js'

export async function fetchMaxBattingHomerunYear(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('stats_homeruns')
    .select('year')
    .eq('role', 'batting')
    .eq('type', 'adj_xhr')
    .order('year', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || data?.year == null) return null
  return Number(data.year)
}
