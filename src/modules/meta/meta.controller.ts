import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../../lib/prisma'

const router = Router()

function getUserId(req: any): string | undefined {
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
  const uid = getUserId(req)
  if (!uid) return null
  const u = await prisma.user.findUnique({ where: { id: uid } })
  return u || null
}

router.get('/brokers', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    
    const names = [
      'Interactive Brokers','Charles Schwab','TD Ameritrade','Fidelity','E*TRADE','Robinhood','Thinkorswim','Webull','Trading 212','Saxo Bank',
      'IG','CMC Markets','Pepperstone','Oanda','FOREX.com','XM','Exness','Axi','FXCM','XTB',
      'Binance','Bybit','OKX','Kraken','Coinbase','Bitstamp','Gate.io','KuCoin','Bitfinex','Gemini'
    ]
    
    const count = await prisma.broker.count({ where: { userId: user.id } })
    if (count === 0) {
        await prisma.broker.createMany({
            data: names.map(name => ({ userId: user.id, name, type: 'multi' }))
        })
    }
    
    const list = await prisma.broker.findMany({ 
        where: { userId: user.id },
        orderBy: { name: 'asc' }
    })
    
    res.json(list.map(b => ({ id: b.id, name: b.name })))
  } catch (e) {
    console.error(e)
    res.status(500).json([])
  }
})

router.get('/accounts', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    
    let broker = await prisma.broker.findFirst({ where: { userId: user.id } })
    if (!broker) {
        broker = await prisma.broker.create({
            data: { userId: user.id, name: 'DefaultBroker', type: 'multi' }
        })
    }
    
    const ensureAccount = async (name: string) => {
      const exists = await prisma.account.findFirst({
          where: { userId: user.id, brokerId: broker!.id, name }
      })
      if (!exists) {
          await prisma.account.create({
              data: { userId: user.id, brokerId: broker!.id, name, currency: 'USD' }
          })
      }
    }
    
    await ensureAccount('Real')
    await ensureAccount('Demo')
    
    const list = await prisma.account.findMany({
        where: { userId: user.id },
        orderBy: { name: 'asc' }
    })
    
    res.json(list.map(a => ({ id: a.id, name: a.name, brokerId: a.brokerId })))
  } catch (e) {
    console.error(e)
    res.status(500).json([])
  }
})

router.get('/strategies', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    
    const names = [
      'Breakout','Trend Following','Mean Reversion','Scalping','Swing','News Trading','Momentum','Reversal','Pullback','Range Trading',
      'VWAP','EMA Cross','SMA Cross','Support/Resistance','Fibonacci','Order Block','Liquidity Grab','Supply/Demand','Smart Money','Volatility Breakout',
      'Opening Range Breakout','Inside Bar','ICT','Price Action'
    ]
    
    const count = await prisma.strategy.count({ where: { userId: user.id } })
    if (count === 0) {
        await prisma.strategy.createMany({
            data: names.map(name => ({ userId: user.id, name }))
        })
    }
    
    const list = await prisma.strategy.findMany({
        where: { userId: user.id },
        orderBy: { name: 'asc' }
    })
    
    res.json(list.map(s => ({ id: s.id, name: s.name })))
  } catch (e) {
    console.error(e)
    res.status(500).json([])
  }
})

export default router
