import { CALIBRATION } from './calibration.js'

const LINEUP_PA: Record<number, number> = {
  1: 4.6, 2: 4.5, 3: 4.4, 4: 4.3,
  5: 4.2, 6: 4.1, 7: 4.0, 8: 3.8, 9: 3.5,
}

export const DEFAULT_EXPECTED_PA = CALIBRATION.expectedPaDefault

export function expectedPaFromLineupSlot(slot: number | null | undefined): number {
  if (slot == null || !Number.isFinite(slot)) return DEFAULT_EXPECTED_PA
  const s = Math.round(Number(slot))
  if (s < 1 || s > 9) return DEFAULT_EXPECTED_PA
  return LINEUP_PA[s] ?? DEFAULT_EXPECTED_PA
}
