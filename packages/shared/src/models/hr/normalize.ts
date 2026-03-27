/** Safe z-score; returns null if std is missing or ~0. */
export function zScore(value: number | null | undefined, mean: number, std: number): number | null {
  if (value == null || !Number.isFinite(value)) return null
  if (!Number.isFinite(mean) || !Number.isFinite(std) || std < 1e-9) return null
  return (value - mean) / std
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
