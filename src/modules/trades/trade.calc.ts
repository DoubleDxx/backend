export type Direction = 'BUY' | 'SELL'
export type ExitLeg = { size: number; exit_price: number; exit_at?: string; fees?: number }

export function calcAvgExitPrice(legs: ExitLeg[]): number | undefined {
  const total = legs.reduce((a, l) => a + l.size, 0)
  if (total === 0) return undefined
  const weighted = legs.reduce((a, l) => a + l.exit_price * l.size, 0)
  return weighted / total
}

export function calcRealizedPnl(direction: Direction, entryPrice: number, legs: ExitLeg[], pointValue: number, defaultFees = 0): number {
  return legs.reduce((sum, l) => {
    const fees = l.fees ?? defaultFees
    const diff = direction === 'BUY' ? (l.exit_price - entryPrice) : (entryPrice - l.exit_price)
    const pnl = diff * l.size * pointValue - fees
    return sum + pnl
  }, 0)
}

export function calcPips(a: number, b: number, pipSize: number): number {
  const d = Math.abs(b - a)
  return pipSize === 0 ? 0 : d / pipSize
}

export function calcRR(entry: number, sl?: number, tp?: number): number | undefined {
  if (sl === undefined || tp === undefined) return undefined
  const risk = Math.abs(entry - sl)
  const reward = Math.abs(tp - entry)
  if (risk === 0) return undefined
  return reward / risk
}

