import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../../lib/prisma'

const router = Router()

async function getRequesterRole(req: any): Promise<'Whitelist' | 'User' | 'Developer' | 'anonymous'> {
  try {
    const auth = req.headers?.authorization || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!token) return 'anonymous'
    const secret = process.env.JWT_SECRET || 'dev-secret'
    const payload = jwt.verify(token, secret) as any
    const user = await prisma.user.findUnique({ where: { id: payload?.uid } })
    if (user) {
        return (user.role as 'Whitelist' | 'User' | 'Developer') || 'User'
    }
    return 'anonymous'
  } catch { return 'anonymous' }
}

router.get('/users', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase()
    const limitRaw = req.query.limit
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : Array.isArray(limitRaw) ? Number(limitRaw[0]) : 20
    const maxLimit = isNaN(limit) ? 20 : Math.max(1, Math.min(limit, 200))

    const where: any = {}
    if (q) {
        where.OR = [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } }
        ]
    }

    const users = await prisma.user.findMany({
        where,
        take: maxLimit,
        orderBy: { name: 'asc' }
    })
    
    const whitelist = await prisma.whitelist.findMany({ select: { email: true } })
    const verifiedEmails = new Set(whitelist.map(w => w.email))

    const result = users.map(u => ({
        id: u.id,
        name: u.name || u.email,
        email: u.email,
        avatarUrl: u.avatarUrl,
        role: u.role,
        isPublic: !!u.isPublic,
        isVerified: verifiedEmails.has(u.email)
    }))
    
    // Sort by name fallback to email manually if needed to match exact behavior, 
    // but DB sort is likely enough.
    
    res.json(result)
  } catch (e) {
    console.error('Public users search error:', e)
    res.status(500).json({ error: 'Failed to search users' })
  }
})

router.get('/journal/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const user = await prisma.user.findUnique({ where: { id: userId } })
    const role = await getRequesterRole(req)
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    if (!user.isPublic && !['Whitelist', 'Developer'].includes(role)) {
      return res.status(403).json({ error: 'Journal is private' })
    }

    const trades = await prisma.trade.findMany({
        where: { userId },
        orderBy: { entryAt: 'desc' },
        include: {
            exitLegs: true,
            screenshots: true,
            strategy: true,
            account: { include: { broker: true } }
        }
    })

    const mapped = trades.map(t => {
      const size = Number(t.lotSize)
      const entry = Number(t.entryPrice)
      const realized = Number(t.realizedPnl)
      const lastLeg = t.exitLegs.length > 0 ? t.exitLegs[t.exitLegs.length - 1] : null
      const exit = lastLeg ? Number(lastLeg.exitPrice) : (() => {
        const tp = t.takeProfit !== null && t.takeProfit !== undefined ? Number(t.takeProfit) : undefined
        const sl = t.stopLoss !== null && t.stopLoss !== undefined ? Number(t.stopLoss) : undefined
        if (realized >= 0 && tp !== undefined) return tp
        if (realized < 0 && sl !== undefined) return sl
        return undefined
      })()
      return {
        ...t,
        at: t.entryAt,
        pnl: realized,
        strategy: t.strategy?.name || 'Unknown',
        screenshots: t.screenshots,
        size,
        entry,
        exit,
        brokerName: t.account?.broker?.name || 'Unknown',
        accountName: t.account?.name || 'Unknown'
      }
    })
    
    res.json(mapped)
  } catch (e) {
    console.error('Public journal fetch error:', e)
    res.status(500).json({ error: 'Failed to fetch public journal' })
  }
})

router.get('/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const user = await prisma.user.findUnique({ where: { id: userId } })
    const role = await getRequesterRole(req)
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    if (!user.isPublic && !['Whitelist', 'Developer'].includes(role)) {
      return res.status(403).json({ error: 'Journal is private' })
    }

    const txs = await prisma.walletTx.findMany({
        where: { userId },
        orderBy: { at: 'desc' }
    })
    
    res.json(txs.map((t) => ({ id: t.id, type: t.type, amount: Number(t.amount), at: t.at, note: t.note })))
  } catch (e) {
    console.error('Public wallet fetch error:', e)
    res.status(500).json({ error: 'Failed to fetch public wallet' })
  }
})

export default router
