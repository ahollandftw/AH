import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchLatestBattingExitVelocity,
  fetchLatestBattingHomerunsAdjXhr,
  mapStatsToLaunchLabProjection,
} from './statsQueries'

export type LaunchLabScreenData = {
  player: {
    /** Statcast player id (canonical key). */
    id: string
    name: string
    team: string
    position: string
    imageUrl?: string | null
    slug?: string | null
  }
  projection: {
    seasonHrProjection: number
    seasonHrVsAvg: number
    verticalLaunchVectorDegrees: number
    sweetSpotPercentage: number
    optimalHrZoneLabel: string
    consistencyScore: number
    exitVelocityMph: number
  }
  /** Where projection numbers came from (for future UI hints). */
  projectionSource?: 'stats_csv' | 'launchlab_table' | 'mock'
}

export const MOCK_LAUNCHLAB_SCREEN_DATA: LaunchLabScreenData = {
  player: {
    id: '660271',
    name: 'Shohei Ohtani',
    team: 'Los Angeles Dodgers',
    position: 'DH / P',
    slug: 'shohei-ohtani',
  },
  projection: {
    seasonHrProjection: 54,
    seasonHrVsAvg: 4.2,
    verticalLaunchVectorDegrees: 12.2,
    sweetSpotPercentage: 12.2,
    optimalHrZoneLabel: '24° - 32°',
    consistencyScore: 94.2,
    exitVelocityMph: 118.4,
  },
  projectionSource: 'mock',
}

function formatSigned(n: number) {
  if (n === 0) return '0.0'
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1)
}

async function loadPlayerForLaunchLab(supabase: SupabaseClient, playerKey: string) {
  const k = playerKey.trim()
  if (/^\d+$/.test(k)) {
    const { data, error } = await supabase
      .from('players')
      .select('stat_player_id,name,team,position,image_url,slug')
      .eq('stat_player_id', k)
      .maybeSingle()
    if (!error && data) return data
  }
  const { data, error } = await supabase
    .from('players')
    .select('stat_player_id,name,team,position,image_url,slug')
    .eq('slug', k.toLowerCase())
    .maybeSingle()
  if (!error && data) return data
  return null
}

/**
 * Fetches Launch Lab screen data. `playerKey` is Statcast id (e.g. "660271") or slug.
 */
export async function fetchLaunchLabScreenData(
  supabase: SupabaseClient,
  playerKey: string,
): Promise<LaunchLabScreenData> {
  try {
    const player = await loadPlayerForLaunchLab(supabase, playerKey)

    if (!player?.stat_player_id) {
      return MOCK_LAUNCHLAB_SCREEN_DATA
    }

    const base = {
      player: {
        id: player.stat_player_id,
        name: player.name,
        team: player.team,
        position: player.position,
        imageUrl: player.image_url,
        slug: player.slug,
      },
    }

    const [ev, hr] = await Promise.all([
      fetchLatestBattingExitVelocity(supabase, player.stat_player_id),
      fetchLatestBattingHomerunsAdjXhr(supabase, player.stat_player_id),
    ])

    if (ev || hr) {
      return {
        ...base,
        projection: mapStatsToLaunchLabProjection(ev, hr),
        projectionSource: 'stats_csv',
      }
    }

    const { data: projection, error: projError } = await supabase
      .from('player_launchlab_projections')
      .select(
        'season_hr_projection,season_hr_vs_avg,vertical_launch_vector_degrees,sweet_spot_percentage,optimal_hr_zone_label,consistency_score,exit_velocity_mph',
      )
      .eq('player_id', player.stat_player_id)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (projError || !projection) {
      return MOCK_LAUNCHLAB_SCREEN_DATA
    }

    return {
      ...base,
      projection: {
        seasonHrProjection: Number(projection.season_hr_projection),
        seasonHrVsAvg: Number(projection.season_hr_vs_avg),
        verticalLaunchVectorDegrees: Number(projection.vertical_launch_vector_degrees),
        sweetSpotPercentage: Number(projection.sweet_spot_percentage),
        optimalHrZoneLabel: projection.optimal_hr_zone_label,
        consistencyScore: Number(projection.consistency_score),
        exitVelocityMph: Number(projection.exit_velocity_mph),
      },
      projectionSource: 'launchlab_table',
    }
  } catch {
    return MOCK_LAUNCHLAB_SCREEN_DATA
  }
}

export function formatSeasonHrVsAvg(n: number) {
  return formatSigned(n)
}
