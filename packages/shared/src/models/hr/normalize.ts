/** Z-score clamped to [-3, +3]. Returns null if inputs are invalid. */
export function zScore(value: number | null | undefined, mean: number, std: number): number | null {
  if (value == null || !Number.isFinite(value)) return null
  if (!Number.isFinite(mean) || !Number.isFinite(std) || std < 1e-9) return null
  return clamp((value - mean) / std, -3, 3)
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function meanStd(values: number[]): { mean: number; std: number } | null {
  const xs = values.filter((v) => Number.isFinite(v))
  if (xs.length < 2) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)
  const std = Math.sqrt(Math.max(v, 0))
  if (std < 1e-9) return null
  return { mean, std }
}
