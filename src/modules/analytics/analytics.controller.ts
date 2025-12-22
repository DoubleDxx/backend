import { Router } from 'express'
import dayjs from 'dayjs'
import { prisma } from '../../lib/prisma'

const router = Router()

function toNum(v: any): number {
  if (v === null || v === undefined) return 0
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

router.get('/summary', async (req, res) => {
  try {
    const userId = (req as any).userId || undefined
    const { from, to, symbol, strategyId, brokerId, accountId, initial } = req.query as Record<string, string>
    
    const where: any = {}
    if (userId) where.userId = userId
    if (symbol) where.symbol = symbol
    if (strategyId) where.strategyId = strategyId
    if (accountId) where.accountId = accountId
    
    if (from || to) {
        where.entryAt = {}
        if (from) where.entryAt.gte = new Date(from)
        if (to) where.entryAt.lte = new Date(to)
    }

    const trades = await prisma.trade.findMany({
        where,
        include: { exitLegs: true },
        orderBy: { entryAt: 'asc' }
    })

    const points: number[] = []
    const series: { t: string; v: number }[] = []
    let netProfit = 0
    const realizedByTrade: number[] = []
    
    // Trades are already sorted by entryAt asc from DB query
    // But let's make sure we handle the logic correctly
    
    for (const t of trades) {
      const entry = toNum(t.entryPrice)
      const dir = t.direction
      const legs = t.exitLegs.map(l => ({ size: toNum(l.size), exit_price: toNum(l.exitPrice), fees: toNum(l.fees) }))
      const pnl = legs.reduce((sum, l) => {
        const diff = dir === 'BUY' ? (l.exit_price - entry) : (entry - l.exit_price)
        return sum + diff * l.size - (l.fees || 0)
      }, 0)
      
      // If we want to use the pre-calculated realizedPnl from DB, we can:
      // const pnl = toNum(t.realizedPnl)
      // But the original code recalculated it from legs. Let's stick to original logic if possible, 
      // or use t.realizedPnl if legs are empty (legacy data might be different).
      // However, t.realizedPnl is reliable in new system. 
      // Let's use the calculated pnl to be safe with partial exits logic above.
      
      netProfit += pnl
      realizedByTrade.push(pnl)
      points.push(pnl)
      series.push({ t: t.entryAt.toISOString(), v: pnl })
    }
    
    const wins = realizedByTrade.filter(v => v > 0)
    const losses = realizedByTrade.filter(v => v <= 0)
    const total = realizedByTrade.length
    const winRate = total ? (wins.length / total) * 100 : 0
    const avgWin = wins.length ? wins.reduce((a,b)=>a+b,0)/wins.length : 0
    const avgLoss = losses.length ? Math.abs(losses.reduce((a,b)=>a+b,0)/losses.length) : 0
    const grossProfit = wins.reduce((a,b)=>a+b,0)
    const grossLoss = Math.abs(losses.reduce((a,b)=>a+b,0))
    const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 100 : 0) : grossProfit / grossLoss
    const expectancy = winRate/100 * avgWin - (1 - winRate/100) * avgLoss
    const init = initial ? Number(initial) : 10000
    let equity = init
    let peak = equity
    let maxDD = 0
    for (const p of series) {
      equity += p.v
      peak = Math.max(peak, equity)
      maxDD = Math.max(maxDD, peak - equity)
    }
    let consW = 0, maxConsW = 0, consL = 0, maxConsL = 0
    for (const v of realizedByTrade) {
      if (v > 0) { consW++; maxConsW = Math.max(maxConsW, consW); consL = 0 } else { consL++; maxConsL = Math.max(maxConsL, consL); consW = 0 }
    }
    
    const txWhere: any = {}
    if (userId) txWhere.userId = userId
    if (from || to) {
        txWhere.at = {}
        if (from) txWhere.at.gte = new Date(from)
        if (to) txWhere.at.lte = new Date(to)
    }
    
    const walletTx = await prisma.walletTx.findMany({ where: txWhere })
    
    const deposits = walletTx.filter((x) => x.type === 'DEPOSIT').reduce((a, b)=>a+Number(b.amount),0)
    const withdraws = walletTx.filter((x) => x.type === 'WITHDRAW' || x.type === 'WITHDRAW_INITIAL').reduce((a, b)=>a+Number(b.amount),0)
    const depositCount = walletTx.filter((x) => x.type === 'DEPOSIT').length
    const withdrawCount = walletTx.filter((x) => x.type === 'WITHDRAW' || x.type === 'WITHDRAW_INITIAL').length
    const balance = init + netProfit + deposits - withdraws
    const growthPct = init>0 ? ((balance - init)/init)*100 : 0

    res.json({
      total,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy,
      maxDrawdown: maxDD,
      consecutiveWins: maxConsW,
      consecutiveLosses: maxConsL,
      netProfit,
      initial: init,
      balance,
      growthPct,
      series: series.slice(-50),
      deposits,
      withdraws,
      depositCount,
      withdrawCount
    })
  } catch (e) {
    console.error('Summary error:', e)
    res.status(500).json({ error: 'failed_summary' })
  }
})

export default router
