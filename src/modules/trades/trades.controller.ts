import { Router, Request, Response } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { authenticateToken, AuthRequest } from '../../middleware/auth.middleware'
import { prisma } from '../../lib/prisma'
import { uploadToFivemanage } from '../../lib/fivemanage'

const router = Router()

// Apply authentication middleware to all routes in this router
router.use(authenticateToken)
// Block viewer role from accessing private trade endpoints
router.use((req, res, next) => {
  const authReq = req as AuthRequest
  // Allow 'User' role (or others) to access trade endpoints
  const roles = authReq.user?.roles || ['User']
  const allowed = ['Whitelist', 'Developer', 'User', 'Trader', 'Creator']
  const hasRole = roles.some((r: string) => allowed.includes(r))
  
  if (!authReq.user || !hasRole) {
    return res.status(403).json({ error: 'forbidden_viewer' })
  }
  next()
})

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads'
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir)
    }
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname)
  }
})

const upload = multer({ storage })

router.post('/', upload.array('images'), async (req, res) => {
  try {
    const authReq = req as AuthRequest
    const userId = authReq.user!.id
    const {
      entry_at, timezone, symbol, market, direction, lot_size, entry_price,
      stop_loss, take_profit, entry_type, order_notes, strategy_id,
      broker_id, account_id, account_name, fees, commission, ticket_id, position_id,
      risk_pct, balance_before, balance_after, result, exit_legs, labels, profit, loss
    } = req.body

    // Basic validation
    if (!symbol || !market || !direction || !entry_type || lot_size === undefined || entry_price === undefined) {
      return res.status(400).json({ error: 'Missing required fields' })
    }
    const toNum = (v: any): number => {
      if (typeof v === 'string') {
        const s = v.replace(/,/g, '.')
        const n = Number(s)
        return isNaN(n) ? 0 : n
      }
      const n = Number(v)
      return isNaN(n) ? 0 : n
    }

    let finalAccountId = account_id
    
    // Try to resolve account from broker_id if provided
    if (!finalAccountId && broker_id) {
        const broker = await prisma.broker.findUnique({ where: { id: broker_id } })
        if (broker) {
           const accName = account_name || 'Real'
           let acc = await prisma.account.findFirst({
               where: { userId, brokerId: broker.id, name: accName }
           })
           if (!acc) {
               acc = await prisma.account.create({
                   data: { userId, brokerId: broker.id, name: accName, currency: 'USD' }
               })
           }
           finalAccountId = acc.id
        }
    }

    if (!finalAccountId && !broker_id) {
        const acc = await prisma.account.findFirst({ where: { userId } })
        if (acc) {
            finalAccountId = acc.id
        } else {
            let broker = await prisma.broker.findFirst({ where: { userId } })
            if (!broker) {
                broker = await prisma.broker.create({
                    data: { userId, name: 'DefaultBroker', type: 'multi' }
                })
            }
            const created = await prisma.account.create({
                data: { userId, brokerId: broker.id, name: 'Real', currency: 'USD' }
            })
            await prisma.account.create({
                data: { userId, brokerId: broker.id, name: 'Demo', currency: 'USD' }
            })
            finalAccountId = created.id
        }
    }

    const realizedPnl = (() => {
      const p = profit !== undefined ? Number(profit) : undefined
      const l = loss !== undefined ? Number(loss) : undefined
      if (p !== undefined || l !== undefined) {
        return (p || 0) - (l || 0)
      }
      if (result === 'WIN') return 100
      if (result === 'LOSE') return -100
      return 0
    })()

    const trade = await prisma.trade.create({
        data: {
            userId,
            entryAt: new Date(entry_at),
            symbol,
            market,
            direction,
            lotSize: toNum(lot_size),
            entryPrice: toNum(entry_price),
            stopLoss: stop_loss !== undefined ? toNum(stop_loss) : null,
            takeProfit: take_profit !== undefined ? toNum(take_profit) : null,
            entryType: entry_type,
            notes: order_notes,
            strategyId: strategy_id || null,
            accountId: finalAccountId,
            fees: fees ? toNum(fees) : 0,
            commission: commission ? toNum(commission) : 0,
            ticketId: ticket_id,
            positionId: position_id,
            riskPct: risk_pct !== undefined ? toNum(risk_pct) : null,
            balanceBefore: balance_before !== undefined ? toNum(balance_before) : null,
            balanceAfter: balance_after !== undefined ? toNum(balance_after) : null,
            status: result === 'WIN' || result === 'LOSE' ? 'CLOSED' : 'OPEN', 
            realizedPnl
        }
    })

    if (result === 'WIN' || result === 'LOSE') {
      const exitPrice = result === 'WIN'
        ? (take_profit !== undefined ? toNum(take_profit) : null)
        : (stop_loss !== undefined ? toNum(stop_loss) : null)
      if (exitPrice !== null) {
        await prisma.exitLeg.create({
            data: {
                tradeId: trade.id,
                size: toNum(lot_size),
                exitPrice: exitPrice,
                exitAt: new Date(entry_at),
                fees: 0
            }
        })
      }
    }

    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files) {
        const localPath = path.join('uploads', file.filename)
        const remoteUrl = await uploadToFivemanage(localPath, file.originalname)
        
        await prisma.screenshot.create({
            data: {
                tradeId: trade.id,
                url: remoteUrl || `/uploads/${file.filename}`
            }
        })

        // If uploaded successfully, delete local file
        if (remoteUrl) {
            try { fs.unlinkSync(localPath) } catch {}
        }
      }
    }

    res.json(trade)
  } catch (e) {
    console.error('Create trade error:', e)
    res.status(500).json({ error: 'Failed to create trade', detail: (e as any)?.message })
  }
})

router.get('/', async (req, res) => {
  try {
    const authReq = req as AuthRequest
    const userId = authReq.user!.id
    
    const allTrades = await prisma.trade.findMany({
        where: { userId },
        orderBy: { entryAt: 'desc' },
        include: {
            exitLegs: true,
            screenshots: true,
            strategy: true,
            account: {
                include: { broker: true }
            }
        }
    })
    
    const mapped = allTrades.map(t => {
      const strategy = t.strategy
      const account = t.account
      const broker = account?.broker

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
        screenshots: t.screenshots,
        size,
        entry,
        exit,
        strategy: strategy?.name || 'Unknown',
        brokerName: broker?.name || 'Unknown',
        accountName: account?.name || 'Unknown'
      }
    })
    
    res.json(mapped)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Failed to fetch trades' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest
    const userId = authReq.user!.id
    const { id } = req.params as any
    const { symbol, direction, realizedPnl, entry_at, take_profit, stop_loss, lot_size, entry_price, exit_price, result } = req.body || {}
    
    // Verify ownership
    const existing = await prisma.trade.findFirst({
        where: { id, userId }
    })
    if (!existing) return res.status(404).json({ error: 'Trade not found' })

    const data: any = {}
    if (symbol !== undefined) data.symbol = String(symbol)
    if (direction === 'BUY' || direction === 'SELL') data.direction = direction
    if (realizedPnl !== undefined && !isNaN(Number(realizedPnl))) data.realizedPnl = Number(realizedPnl)
    if (entry_at) {
      const d = new Date(entry_at)
      if (!isNaN(d.getTime())) data.entryAt = d
    }
    if (take_profit !== undefined && !isNaN(Number(take_profit))) data.takeProfit = Number(take_profit)
    if (stop_loss !== undefined && !isNaN(Number(stop_loss))) data.stopLoss = Number(stop_loss)
    if (lot_size !== undefined && !isNaN(Number(lot_size))) data.lotSize = Number(lot_size)
    if (entry_price !== undefined && !isNaN(Number(entry_price))) data.entryPrice = Number(entry_price)
    if (result === 'WIN' || result === 'LOSE') data.status = 'CLOSED'
    if (result === 'OPEN') data.status = 'OPEN'
    if (exit_price !== undefined && !isNaN(Number(exit_price))) {
      const ep = Number(exit_price)
      if (result === 'WIN') data.takeProfit = ep
      if (result === 'LOSE') data.stopLoss = ep
    }
    
    const updated = await prisma.trade.update({
        where: { id },
        data
    })
    res.json({ id: updated?.id })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'update_trade_failed' })
  }
})

export default router
