export { createSupabaseClient } from './supabase'
export type { LaunchLabScreenData } from './launchLab'
export {
  MOCK_LAUNCHLAB_SCREEN_DATA,
  fetchLaunchLabScreenData,
  formatSeasonHrVsAvg,
} from './launchLab'

export type { UserSettings, WatchlistPlayer } from './watchlist'
export {
  addToWatchlistByPlayerKey,
  addToWatchlistBySlug,
  getOrCreateUserSettings,
  listWatchlistPlayers,
  removeFromWatchlist,
  resolveStatPlayerId,
  setGlobalAlertsEnabled,
} from './watchlist'

export type { DailyProjection } from './projections'
export {
  formatProbability,
  groupProjectionsByTier,
  listDailyHrProjections,
} from './projections'

export type { HrProbabilityInput, HrProbabilityResult } from './hrProbability'
export {
  calculateHrProbability,
  calcPowerScore,
  calcPitcherFactor,
  calcBaseHrRate,
  calcNormalizedMatchup,
  formatAmericanOdds,
  probToAmericanOdds,
  probToTier,
} from './hrProbability'

export {
  HOMERUNS_LEADERBOARD_TYPE,
  fetchBattingAdjXhrLeaderboard,
  fetchLatestBattingExitVelocity,
  fetchLatestBattingHomerunsAdjXhr,
  fetchMaxBattingHomerunYear,
  mapStatsToLaunchLabProjection,
  xhrToDisplayProbability,
  xhrToTier,
} from './statsQueries'

export { deleteAllPushTokensForUser, upsertExpoPushToken } from './pushTokens'

export { getAppDisplayDateIso } from './displayDate'

export type { ScheduleGame } from './schedule'
export { getGamesForDate, getScheduleDates, getTeamsPlayingOn } from './schedule'
