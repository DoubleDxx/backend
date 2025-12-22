import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import dayjs from 'dayjs'
import jwt from 'jsonwebtoken'

const router = Router()

function getUid(req: any): string | undefined {
  try {
    const auth = req.headers?.authorization || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!token) return undefined
    const secret = process.env.JWT_SECRET || 'dev-secret'
    const payload = jwt.verify(token, secret) as any
    return payload?.uid
  } catch { return undefined }
}

async function ensureUser(req: any) {
  const uid = getUid(req)
  if (!uid) return null
  const u = await prisma.user.findUnique({ where: { id: uid } })
  return u || null
}

function ensureEditorOr403(req: any, res: any, user: any) {
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return false }
  const role = user.role || 'User'
  if (!['Whitelist', 'Developer'].includes(role)) { res.status(403).json({ error: 'forbidden_user' }); return false }
  return true
}

router.get('/transactions', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const txs = await prisma.walletTx.findMany({
        where: { userId: user.id },
        orderBy: { at: 'desc' }
    })
    res.json(txs.map((t) => ({ id: t.id, type: t.type, amount: Number(t.amount), at: t.at, note: t.note })))
  } catch (e) { res.status(500).json({ error: 'wallet_list_failed' }) }
})

router.post('/deposit', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!ensureEditorOr403(req, res, user)) return
    if (!user) return
    const { amount, at, account_id, note } = req.body || {}
    const a = Number(String(amount || '0').replace(/,/g, '.'))
    if (!a || a <= 0) return res.status(400).json({ error: 'invalid_amount' })
    
    const tx = await prisma.walletTx.create({
        data: {
            userId: user.id,
            accountId: account_id || null,
            type: 'DEPOSIT',
            amount: a,
            at: at ? new Date(at) : new Date(),
            note,
            createdAt: new Date()
        }
    })
    res.json({ id: tx.id })
  } catch (e) { res.status(500).json({ error: 'deposit_failed' }) }
})

router.post('/withdraw', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!ensureEditorOr403(req, res, user)) return
    if (!user) return
    const { amount, isInitial, account_id, note, at } = req.body
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'invalid_amount' })
    const type = isInitial ? 'WITHDRAW_INITIAL' : 'WITHDRAW'
    
    const tx = await prisma.walletTx.create({
        data: {
            userId: user.id,
            accountId: account_id || null,
            type,
            amount: Number(amount),
            at: at ? new Date(at) : new Date(),
            note,
            createdAt: new Date()
        }
    })
    res.json({ id: tx.id })
  } catch (e) { res.status(500).json({ error: 'withdraw_failed' }) }
})

router.get('/balance', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { from, initial } = req.query as Record<string, string>
    const init = initial ? Number(initial) : 0
    
    let fromDate: Date | undefined = undefined
    if (from) fromDate = new Date(from)

    const depAgg = await prisma.walletTx.aggregate({
        where: { 
            userId: user.id, 
            type: 'DEPOSIT',
            at: fromDate ? { gte: fromDate } : undefined
        },
        _sum: { amount: true }
    })

    const wdAgg = await prisma.walletTx.aggregate({
        where: { 
            userId: user.id, 
            type: { in: ['WITHDRAW', 'WITHDRAW_INITIAL'] },
            at: fromDate ? { gte: fromDate } : undefined
        },
        _sum: { amount: true }
    })
    
    const tradeAgg = await prisma.trade.aggregate({
        where: {
            userId: user.id,
            entryAt: fromDate ? { gte: fromDate } : undefined
        },
        _sum: { realizedPnl: true }
    })

    const dep = depAgg._sum.amount || 0
    const wd = wdAgg._sum.amount || 0
    const netTrades = tradeAgg._sum.realizedPnl || 0

    const balance = init + dep - wd + netTrades
    res.json({ initial: init, deposits: dep, withdraws: wd, netProfitFromTrades: netTrades, balance })
  } catch (e) { 
      console.error(e)
      res.status(500).json({ error: 'balance_failed' }) 
  }
})

router.post('/reset', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!ensureEditorOr403(req, res, user)) return
    if (!user) return
    const { scope, from } = req.body || {}
    
    if (scope === 'all') {
        // Delete primary data
        // Trade deletion cascades to ExitLegs and Screenshots
        await prisma.trade.deleteMany({ where: { userId: user.id } })
        await prisma.walletTx.deleteMany({ where: { userId: user.id } })
        await prisma.note.deleteMany({ where: { userId: user.id } })
        
        // Delete meta
        await prisma.strategy.deleteMany({ where: { userId: user.id } })
        await prisma.account.deleteMany({ where: { userId: user.id } })
        await prisma.broker.deleteMany({ where: { userId: user.id } })
        
        return res.json({ success: true })
    }

    let gte: Date | undefined = undefined
    if (from) {
      const d = new Date(from)
      if (!isNaN(d.getTime())) gte = d
    } else if (scope === 'daily') {
      gte = dayjs().startOf('day').toDate()
    } else if (scope === 'weekly') {
      gte = dayjs().startOf('week').toDate()
    } else if (scope === 'monthly') {
      gte = dayjs().startOf('month').toDate()
    }

    if (gte) {
       await prisma.walletTx.deleteMany({ where: { userId: user.id, at: { gte } } })
       await prisma.trade.deleteMany({ where: { userId: user.id, entryAt: { gte } } })
    }
    
    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'reset_failed' })
  }
})

export default router
