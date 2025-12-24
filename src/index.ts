import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

// Manual .env loader since dotenv might be missing
try {
  const envPath = path.join(__dirname, '../.env')
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8')
    envConfig.split('\n').forEach(line => {
      const parts = line.split('=')
      if (parts.length >= 2 && !line.trim().startsWith('#')) {
        const key = parts[0].trim()
        const val = parts.slice(1).join('=').trim().replace(/^["'](.*)["']$/, '$1')
        if (!process.env[key]) {
           process.env[key] = val
        }
      }
    })
    console.log('.env loaded manually')
  }
} catch (e) { console.error('Error loading .env', e) }

import timezone from 'dayjs/plugin/timezone'
import { json } from 'express'
import { calcRealizedPnl, calcAvgExitPrice, calcPips, calcRR } from './modules/trades/trade.calc'
import analyticsRouter from './modules/analytics/analytics.controller'
import authRouter from './modules/auth/auth.controller'
import metaRouter from './modules/meta/meta.controller'
import tradesRouter from './modules/trades/trades.controller'
import walletRouter from './modules/wallet/wallet.controller'
import notesRouter from './modules/notes/notes.controller'
import publicRouter from './modules/public/public.controller'
import adminRouter from './modules/admin/admin.controller'
import paymentRouter, { xenditWebhook } from './modules/payment/payment.controller'

dayjs.extend(utc)
dayjs.extend(timezone)

const app = express()
app.use(cors())
app.use(json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))
app.use(express.static(path.join(__dirname, '../../frontend/dist')))

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/api/trades/calc-preview', (req, res) => {
  const { direction, entry_price, exit_legs, pip_size, point_value, fees = 0 } = req.body || {}
  const avgExit = calcAvgExitPrice(exit_legs || [])
  const realized = calcRealizedPnl(direction, entry_price, exit_legs || [], point_value, fees)
  const pips = exit_legs && exit_legs.length > 0 ? calcPips(entry_price, exit_legs[0].exit_price, pip_size) : 0
  res.json({ avgExitPrice: avgExit, realizedPnl: realized, pips })
})

app.use('/api/analytics', analyticsRouter)
app.use('/api/auth', authRouter)
app.use('/api', metaRouter)
app.use('/api/trades', tradesRouter)
app.use('/api/wallet', walletRouter)
app.use('/api/notes', notesRouter)
app.use('/api/public', publicRouter)
app.use('/api/admin', adminRouter)
app.use('/api/payment', paymentRouter)
app.post('/api/webhook/xendit', xenditWebhook)

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' })
  }
  res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'))
})

const port = process.env.PORT || 4000
app.listen(port, () => {
  console.log(`Server started on port ${port}`)
})
