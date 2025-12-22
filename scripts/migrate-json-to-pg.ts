import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const DATA_DIR = path.join(__dirname, '../data')

function readJson(filename: string) {
  const p = path.join(DATA_DIR, filename)
  if (!fs.existsSync(p)) return []
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

async function main() {
  console.log('Starting migration...')

  // 1. Whitelist
  const whitelist = readJson('whitelist.json')
  console.log(`Migrating ${whitelist.length} whitelist entries...`)
  for (const w of whitelist) {
    await prisma.whitelist.upsert({
      where: { email: w.email },
      update: {},
      create: {
        id: w.id,
        email: w.email,
        passwordHash: w.passwordHash,
        createdAt: w.createdAt ? new Date(w.createdAt) : undefined
      }
    })
  }

  // 2. InstrumentMeta
  const metas = readJson('instrument_metas.json')
  console.log(`Migrating ${metas.length} instrument metas...`)
  for (const m of metas) {
    await prisma.instrumentMeta.upsert({
      where: { symbol: m.symbol },
      update: { pipSize: m.pipSize, pointValue: m.pointValue },
      create: {
        id: m.id,
        symbol: m.symbol,
        pipSize: m.pipSize,
        pointValue: m.pointValue
      }
    })
  }

  // 3. Users & Viewers
  const users = readJson('users.json')
  const viewers = readJson('viewers.json')
  const viewerAvatars = readJson('viewer_avatars.json')
  
  console.log(`Migrating ${users.length} admins and ${viewers.length} viewers...`)
  
  // Admins
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        id: u.id,
        email: u.email,
        passwordHash: u.passwordHash,
        name: u.name,
        role: 'admin',
        isPublic: u.isPublic || false,
        profileTag: u.profileTag,
        avatarUrl: u.avatarUrl,
        createdAt: u.createdAt ? new Date(u.createdAt) : undefined
      }
    })
  }

  // Viewers
  for (const v of viewers) {
    // Check if user exists (could be same email?)
    const exists = await prisma.user.findUnique({ where: { email: v.email } })
    if (exists) {
        console.log(`Skipping viewer ${v.email} (already exists)`)
        continue
    }
    const avatar = viewerAvatars.find((a: any) => a.viewerId === v.id)
    await prisma.user.create({
      data: {
        id: v.id,
        email: v.email,
        passwordHash: v.passwordHash,
        name: v.name,
        role: 'viewer',
        avatarUrl: avatar?.url,
        createdAt: v.createdAt ? new Date(v.createdAt) : undefined
      }
    })
  }

  // 4. Brokers
  const brokers = readJson('brokers.json')
  console.log(`Migrating ${brokers.length} brokers...`)
  for (const b of brokers) {
      // Ensure user exists
      const userExists = await prisma.user.findUnique({ where: { id: b.userId } })
      if (!userExists) {
          console.warn(`Broker ${b.id} has invalid userId ${b.userId}, skipping`)
          continue
      }
      await prisma.broker.upsert({
          where: { id: b.id },
          update: {},
          create: {
              id: b.id,
              userId: b.userId,
              name: b.name,
              type: b.type
          }
      })
  }

  // 5. Accounts
  const accounts = readJson('accounts.json')
  console.log(`Migrating ${accounts.length} accounts...`)
  for (const a of accounts) {
      const userExists = await prisma.user.findUnique({ where: { id: a.userId } })
      if (!userExists) continue
      
      // Check broker
      if (a.brokerId) {
          const brokerExists = await prisma.broker.findUnique({ where: { id: a.brokerId } })
          if (!brokerExists) {
              console.warn(`Account ${a.id} has invalid brokerId ${a.brokerId}, setting null`)
              a.brokerId = null
          }
      }

      await prisma.account.upsert({
          where: { id: a.id },
          update: {},
          create: {
              id: a.id,
              userId: a.userId,
              brokerId: a.brokerId,
              name: a.name,
              currency: a.currency
          }
      })
  }

  // 6. Strategies
  const strategies = readJson('strategies.json')
  console.log(`Migrating ${strategies.length} strategies...`)
  for (const s of strategies) {
      const userExists = await prisma.user.findUnique({ where: { id: s.userId } })
      if (!userExists) continue

      await prisma.strategy.upsert({
          where: { id: s.id },
          update: {},
          create: {
              id: s.id,
              userId: s.userId,
              name: s.name
          }
      })
  }

  // 7. Trades
  const trades = readJson('trades.json')
  console.log(`Migrating ${trades.length} trades...`)
  for (const t of trades) {
      const userExists = await prisma.user.findUnique({ where: { id: t.userId } })
      if (!userExists) continue
      
      // Link optional relations if they exist
      if (t.accountId) {
          const acc = await prisma.account.findUnique({ where: { id: t.accountId } })
          if (!acc) t.accountId = null
      }
      if (t.strategyId) {
          const strat = await prisma.strategy.findUnique({ where: { id: t.strategyId } })
          if (!strat) t.strategyId = null
      }

      await prisma.trade.upsert({
          where: { id: t.id },
          update: {},
          create: {
              id: t.id,
              userId: t.userId,
              accountId: t.accountId,
              strategyId: t.strategyId,
              symbol: t.symbol,
              market: t.market,
              direction: t.direction,
              lotSize: Number(t.lotSize),
              entryPrice: Number(t.entryPrice),
              stopLoss: t.stopLoss ? Number(t.stopLoss) : null,
              takeProfit: t.takeProfit ? Number(t.takeProfit) : null,
              entryAt: new Date(t.entryAt),
              status: t.status || 'OPEN',
              realizedPnl: t.realizedPnl ? Number(t.realizedPnl) : null,
              entryType: t.entryType,
              notes: t.notes,
              fees: t.fees ? Number(t.fees) : null,
              commission: t.commission ? Number(t.commission) : null,
              ticketId: t.ticketId || null,
              positionId: t.positionId || null,
              riskPct: t.riskPct ? Number(t.riskPct) : null,
              balanceBefore: t.balanceBefore ? Number(t.balanceBefore) : null,
              balanceAfter: t.balanceAfter ? Number(t.balanceAfter) : null
          }
      })
  }

  // 8. Exit Legs
  const legs = readJson('exit_legs.json')
  console.log(`Migrating ${legs.length} exit legs...`)
  for (const l of legs) {
      const tradeExists = await prisma.trade.findUnique({ where: { id: l.tradeId } })
      if (!tradeExists) continue

      await prisma.exitLeg.upsert({
          where: { id: l.id },
          update: {},
          create: {
              id: l.id,
              tradeId: l.tradeId,
              size: Number(l.size),
              exitPrice: Number(l.exitPrice),
              exitAt: new Date(l.exitAt),
              fees: l.fees ? Number(l.fees) : 0
          }
      })
  }

  // 9. Screenshots
  const screenshots = readJson('screenshots.json')
  console.log(`Migrating ${screenshots.length} screenshots...`)
  for (const s of screenshots) {
      const tradeExists = await prisma.trade.findUnique({ where: { id: s.tradeId } })
      if (!tradeExists) continue

      await prisma.screenshot.upsert({
          where: { id: s.id },
          update: {},
          create: {
              id: s.id,
              tradeId: s.tradeId,
              url: s.url
          }
      })
  }

  // 10. Wallet Txs
  const txs = readJson('wallet_txs.json')
  console.log(`Migrating ${txs.length} wallet txs...`)
  for (const tx of txs) {
      const userExists = await prisma.user.findUnique({ where: { id: tx.userId } })
      if (!userExists) continue
      
      if (tx.accountId) {
          const acc = await prisma.account.findUnique({ where: { id: tx.accountId } })
          if (!acc) tx.accountId = null
      }

      await prisma.walletTx.upsert({
          where: { id: tx.id },
          update: {},
          create: {
              id: tx.id,
              userId: tx.userId,
              accountId: tx.accountId,
              type: tx.type,
              amount: Number(tx.amount),
              at: new Date(tx.at),
              note: tx.note,
              createdAt: tx.createdAt ? new Date(tx.createdAt) : new Date(tx.at)
          }
      })
  }

  // 11. Notes
  const notes = readJson('notes.json')
  console.log(`Migrating ${notes.length} notes...`)
  for (const n of notes) {
      const userExists = await prisma.user.findUnique({ where: { id: n.userId } })
      if (!userExists) continue
      
      if (n.strategyId) {
          const s = await prisma.strategy.findUnique({ where: { id: n.strategyId } })
          if (!s) n.strategyId = null
      }

      await prisma.note.upsert({
          where: { id: n.id },
          update: {},
          create: {
              id: n.id,
              userId: n.userId,
              strategyId: n.strategyId,
              date: new Date(n.date),
              content: n.content || n.note // handle possible name mismatch
          }
      })
  }

  console.log('Migration completed!')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
