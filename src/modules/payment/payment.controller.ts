import { Router } from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import dayjs from 'dayjs'
import Xendit from 'xendit-node'
const midtransClient = require('midtrans-client')
import { prisma } from '../../lib/prisma'
import { User, Prisma } from '@prisma/client'

const router = Router()

function num(v: any): number { const n = Number(v); return isNaN(n) ? 0 : n }
function amountByPlan(p: string): number {
  if (p === 'monthly') return 2
  if (p === 'quarterly') return 5
  if (p === '6months') return 9
  if (p === 'yearly') return 18
  if (p === 'pro') return 80
  if (p === 'creator') return 200
  return 2
}

function calculateNewExpiry(currentExpiry: Date | null | undefined, plan: string): Date | null {
  const p = String(plan || '').toLowerCase()
  if (p === 'creator' || p === 'pro' || p === 'lifetime') return null // Lifetime

  const now = dayjs()
  let base = (currentExpiry && dayjs(currentExpiry).isAfter(now)) ? dayjs(currentExpiry) : now

  if (p === 'monthly') return base.add(1, 'month').toDate()
  if (p === 'quarterly') return base.add(3, 'month').toDate()
  if (p === '6months') return base.add(6, 'month').toDate()
  if (p === 'yearly') return base.add(1, 'year').toDate()
  
  return base.add(1, 'month').toDate() // Default
}


function amountByPlanIDR(p: string): number {
  if (p === 'monthly') return 30000
  if (p === 'quarterly') return 75000
  if (p === '6months') return 140000
  if (p === 'yearly') return 270000
  if (p === 'pro') return 1200000
  if (p === 'creator') return 3000000
  return 30000
}

async function getRequester(req: any): Promise<{ id: string; roles: string[] } | null> {
  try {
    const auth = req.headers?.authorization || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!token) return null
    const secret = process.env.JWT_SECRET || 'dev-secret'
    const payload = jwt.verify(token, secret) as any
    const user = await prisma.user.findUnique({ where: { id: payload?.uid } })
    if (!user) return null
    return { id: user.id, roles: user.roles || ['User'] }
  } catch { return null }
}

function isDeveloper(requester: { roles: string[] } | null) {
  if (!requester) return false
  const roles = (requester.roles || []).map(r => String(r).toLowerCase())
  return roles.some(r => r === 'developer')
}

function canManageCoupons(requester: { roles: string[] } | null) {
  if (!requester) return false
  const roles = (requester.roles || []).map(r => String(r).toLowerCase())
  return roles.some(r => r === 'developer' || r === 'creator')
}

async function ensureDefaultPricing() {
  const existing = await prisma.pricing.findMany()
  if (existing.length > 0) return existing
  const plans = ['monthly','quarterly','6months','yearly','pro','creator']
  for (const p of plans) {
    const usd = amountByPlan(p)
    const idr = amountByPlanIDR(p)
    await prisma.pricing.create({ data: { plan: p, currentUsd: usd, originalUsd: usd, currentIdr: idr, originalIdr: idr } })
  }
  return await prisma.pricing.findMany()
}

async function getPricing(plan: string): Promise<{ currentUsd: number; originalUsd: number; currentIdr: number; originalIdr: number } | null> {
  try {
    if (!plan) return null
    const row = await prisma.pricing.findUnique({ where: { plan } })
    if (row) {
      return {
        currentUsd: num((row as any).currentUsd),
        originalUsd: num((row as any).originalUsd),
        currentIdr: num((row as any).currentIdr),
        originalIdr: num((row as any).originalIdr)
      }
    }
    return null
  } catch {
    return null
  }
}

router.get('/pricing', async (req, res) => {
  try {
    const list = await ensureDefaultPricing()
    res.json(list)
  } catch {
    res.status(500).json({ error: 'pricing_list_error' })
  }
})

router.patch('/pricing', async (req, res) => {
  try {
    const requester = await getRequester(req)
    if (!isDeveloper(requester)) return res.status(403).json({ error: 'forbidden_user' })
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (items.length === 0) return res.status(400).json({ error: 'invalid_payload' })
    for (const it of items) {
      const plan = String(it.plan || '')
      if (!plan) continue
      const data = {
        currentUsd: num(it.currentUsd),
        originalUsd: num(it.originalUsd),
        currentIdr: num(it.currentIdr),
        originalIdr: num(it.originalIdr)
      }
      await prisma.pricing.upsert({
        where: { plan },
        update: data,
        create: { plan, ...data }
      })
    }
    const list = await prisma.pricing.findMany()
    res.json({ ok: true, items: list })
  } catch {
    res.status(500).json({ error: 'pricing_update_error' })
  }
})

router.post('/pricing/reset', async (req, res) => {
  try {
    const requester = await getRequester(req)
    if (!isDeveloper(requester)) return res.status(403).json({ error: 'forbidden_user' })
    const list = await ensureDefaultPricing()
    for (const it of list) {
      await prisma.pricing.update({
        where: { plan: (it as any).plan },
        data: { currentUsd: num((it as any).originalUsd), currentIdr: num((it as any).originalIdr) }
      })
    }
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'pricing_reset_error' })
  }
})

router.post('/paypal/create', async (req, res) => {
  try {
    const clientId = process.env.PAYPAL_CLIENT_ID || ''
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET || ''
    const base = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com'
    const { plan, couponCode, currency = 'USD', description = 'Subscription' } = req.body || {}
    const p = String(plan || '')
    let amount = amountByPlan(p)
    const priceRow = await getPricing(p)
    if (priceRow && num(priceRow.currentUsd) > 0) amount = num(priceRow.currentUsd)
    const key = String(couponCode || '').trim().toUpperCase()
    if (key) {
      try {
        const fromDb = await prisma.coupon.findUnique({ where: { code: key } })
        let rule: { percent?: number; amountOff?: number } | null = null
        if (fromDb && new Date(fromDb.expiresAt).getTime() > Date.now()) {
          rule = { percent: fromDb.percent || undefined, amountOff: fromDb.amountOff || undefined }
        }
        if (rule) {
          const pct = Number(rule.percent || 0)
          const off = Number(rule.amountOff || 0)
          if (pct) amount = Math.max(0, amount * (1 - pct / 100))
          if (off) amount = Math.max(0, amount - off)
          amount = Math.round(amount * 100) / 100
        }
      } catch {}
    }
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const tokenResp = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    })
    if (!tokenResp.ok) return res.status(500).json({ error: 'paypal_auth_failed' })
    const tokenJson: any = await tokenResp.json()
    const access = tokenJson.access_token
    const orderResp = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: String(currency), value: String(amount) }, description }],
        application_context: { return_url: process.env.PAYPAL_RETURN_URL || 'https://example.com/success', cancel_url: process.env.PAYPAL_CANCEL_URL || 'https://example.com/cancel' }
      })
    })
    const orderJson: any = await orderResp.json()
    if (!orderResp.ok) return res.status(500).json({ error: 'paypal_create_failed', details: orderJson })
    const approve = Array.isArray(orderJson.links) ? orderJson.links.find((l: any) => l.rel === 'approve')?.href : undefined
    res.json({ id: orderJson.id, approve_url: approve })
  } catch (e) {
    res.status(500).json({ error: 'paypal_error' })
  }
})

router.post('/redeem/validate', async (req, res) => {
  try {
    const requester = await getRequester(req)
    if (!requester) return res.status(401).json({ error: 'login_required' })
    
    const { plan, code } = req.body || {}
    const p = String(plan || '')
    let base = amountByPlan(p)
    const priceRow = await getPricing(p)
    if (priceRow && num(priceRow.currentUsd) > 0) base = num(priceRow.currentUsd)
    const key = String(code || '').trim().toUpperCase()
    
    // Check DB first
    const fromDb = await prisma.coupon.findUnique({ where: { code: key } })
    
    // Fallback to Env/Hardcoded if not in DB
    let rule: { percent?: number; amountOff?: number } | null = null
    
    if (fromDb) {
      if (new Date(fromDb.expiresAt).getTime() <= Date.now()) {
        // Expired in DB but might check fallback? No, DB takes precedence if exists
        // Actually if it exists in DB it overrides env
      } else {
        rule = { percent: fromDb.percent || undefined, amountOff: fromDb.amountOff || undefined }
      }
    } else {
      // Check env
      const cfg = process.env.REDEEM_CODES || ''
      let map: Record<string, { percent?: number; amountOff?: number }> = {}
      try { if (cfg) map = JSON.parse(cfg) } catch {}
      if (Object.keys(map).length === 0) {
        map = {
          'WELCOME10': { percent: 10 },
          'SAVE5': { amountOff: 5 }
        }
      }
      rule = map[key]
    }

    if (!rule) return res.status(400).json({ error: 'invalid_code' })
    
    // Usage Check
    if (fromDb) {
       // Check usage in DB
       const usage = await prisma.couponUsage.findFirst({
         where: {
           code: key,
           userId: requester.id,
           expiresAt: { gt: new Date() } // Usage valid if expiresAt > now
         }
       })
       if (usage) return res.status(400).json({ error: 'already_used' })
       
       // Record usage logic moved to payment success
    }

    const pct = Number(rule.percent || 0)
    const off = Number(rule.amountOff || 0)
    let final = base
    if (pct) final = Math.max(0, final * (1 - pct / 100))
    if (off) final = Math.max(0, final - off)
    final = Math.round(final * 100) / 100
    
    res.json({ ok: true, percent: pct, amountOff: off, final })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'redeem_validate_error' })
  }
})

router.get('/coupons', async (req, res) => {
  try {
    const requester = await getRequester(req)
    if (!canManageCoupons(requester)) return res.status(403).json({ error: 'forbidden_user' })
    
    const list = await prisma.coupon.findMany({
      where: { expiresAt: { gt: new Date() } },
      include: { _count: { select: { usages: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json(list)
  } catch {
    res.status(500).json({ error: 'coupons_list_error' })
  }
})

router.post('/coupons', async (req, res) => {
  try {
    const requester = await getRequester(req)
    if (!canManageCoupons(requester) || !requester) return res.status(403).json({ error: 'forbidden_user' })
    
    const { code, percent, amountOff, durationDays } = req.body || {}
    const c = String(code || '').trim().toUpperCase()
    const p = percent !== undefined ? Number(percent) : undefined
    const a = amountOff !== undefined ? Number(amountOff) : undefined
    const d = Number(durationDays || 0)
    
    if (!c) return res.status(400).json({ error: 'invalid_code' })
    if (p !== undefined) {
      if (isNaN(p) || p < 1 || p > 20) return res.status(400).json({ error: 'invalid_percent' })
    }
    if (a !== undefined) {
      if (isNaN(a) || a <= 0) return res.status(400).json({ error: 'invalid_amount_off' })
    }
    if (isNaN(d) || d < 1 || d > 14) return res.status(400).json({ error: 'invalid_duration' })
    
    const expiresAt = new Date(Date.now() + d * 24 * 60 * 60 * 1000)
    
    // Purge existing coupon if exists (to reset usage logic as requested)
    // Deleting coupon will cascade delete usages due to schema relation
    try {
      await prisma.coupon.delete({ where: { code: c } })
    } catch {} // Ignore if not exists

    await prisma.coupon.create({
      data: {
        code: c,
        percent: p,
        amountOff: a,
        duration: d,
        expiresAt: expiresAt
      }
    })
    
    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'coupon_create_error' })
  }
})

router.delete('/coupons/:code', async (req, res) => {
  try {
    const requester = await getRequester(req)
    if (!canManageCoupons(requester)) return res.status(403).json({ error: 'forbidden_user' })
    
    const c = String(req.params.code || '').trim().toUpperCase()
    if (!c) return res.status(400).json({ error: 'invalid_code' })
    
    // Deleting coupon will cascade delete usages
    await prisma.coupon.delete({ where: { code: c } })
    
    res.json({ ok: true })
  } catch (e) {
    // If record not found, prisma throws. We can treat as success or 404.
    // Treating as success (idempotent) or error is fine. 
    // Usually user sees list, clicks delete, so it should exist.
    console.error(e)
    res.status(500).json({ error: 'coupon_delete_error' })
  }
})

router.post('/paypal/webhook', async (req, res) => {
  try {
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'paypal_webhook_error' })
  }
})

router.post('/xendit/create', async (req, res) => {
  try {
    const { plan, email, couponCode } = req.body
    if (!plan || !email) return res.status(400).json({ error: 'missing_fields' })

    // Security: Calculate amount on backend
    let amount = amountByPlanIDR(plan)
    const priceRow = await getPricing(String(plan))
    if (priceRow && num(priceRow.currentIdr) > 0) amount = num(priceRow.currentIdr)
    const key = String(couponCode || '').trim().toUpperCase()
    if (key) {
      try {
        const fromDb = await prisma.coupon.findUnique({ where: { code: key } })
        let rule: { percent?: number; amountOff?: number } | null = null
        if (fromDb && new Date(fromDb.expiresAt).getTime() > Date.now()) {
          rule = { percent: fromDb.percent || undefined, amountOff: fromDb.amountOff || undefined }
        }
        if (rule) {
          const pct = Number(rule.percent || 0)
          const offUsd = Number(rule.amountOff || 0)
          if (pct) amount = Math.max(0, amount * (1 - pct / 100))
          if (offUsd) amount = Math.max(0, amount - offUsd * 15000)
        }
      } catch {}
    }
    if (amount < 10000) return res.status(400).json({ error: 'invalid_amount' })

    const secretKey = process.env.XENDIT_SECRET_KEY || ''
    console.log("Xendit Key loaded:", secretKey ? secretKey.substring(0, 8) + '...' : 'NONE')
    console.log("Creating Invoice for:", { plan, amount, email })

    const x = new Xendit({
        secretKey: secretKey
    })

    const safePlan = String(plan || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '')
    const extId = `invoice-${safePlan}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    const resp = await x.Invoice.createInvoice({
        data: {
            externalId: extId,
            amount: amount,
            payerEmail: email,
            description: `Subscription Plan: ${plan}`,
            shouldSendEmail: true
        }
    })

    try {
      const u = await prisma.user.findUnique({ where: { email } })
      if (u) {
        const existing = await prisma.paymentLog.findUnique({ where: { orderId: extId } })
        if (!existing) {
          await (prisma as any).paymentLog.create({ data: { orderId: extId, userId: u.id, amount, status: 'PENDING', couponCode, plan, createdAt: new Date() } })
        }
      }
    } catch {}

    res.json({ invoice_url: resp.invoiceUrl })
  } catch (e: any) {
    console.error("XENDIT ERROR:", JSON.stringify(e, null, 2))
    console.error("XENDIT MSG:", e.message)
    res.status(500).json({ error: e.message || 'xendit_error' })
  }
})

export async function xenditWebhook(req: any, res: any) {
    try {
      const tokenHeader = (req.headers['x-callback-token'] || req.headers['X-Callback-Token']) as string | undefined
      const expected = process.env.XENDIT_CALLBACK_TOKEN || ''
      if (!expected || String(tokenHeader || '') !== expected) {
        return res.status(401).json({ error: 'invalid_token' })
      }
      const body: any = req.body || {}
      console.log('XENDIT WEBHOOK', { headers: req.headers, body })
      const event = String(body?.event || '')
      const status = String(body?.status || body?.data?.status || '')
      const externalId = String(body?.external_id || body?.data?.external_id || '')
      const invoiceId = String(body?.id || body?.data?.id || '')
      const amount = num(body?.amount || body?.data?.amount)
      const payerEmail = String(body?.payer_email || body?.data?.payer_email || '')
      const vaAccount = String(body?.account_number || body?.data?.account_number || '')
      const bankCode = String(body?.bank_code || body?.data?.bank_code || '')
      const paymentId = String(body?.payment_id || body?.data?.payment_id || '')
      const merchantCode = String(body?.merchant_code || body?.data?.merchant_code || '')
      const txTs = String(body?.transaction_timestamp || body?.data?.transaction_timestamp || '')
      const finalOrderId = externalId || invoiceId || ''
      
      try {
        await (prisma as any).webhookLog.create({ data: { event: event || (status ? `invoice.${String(status).toLowerCase()}` : ''), payload: JSON.stringify(body), createdAt: new Date() } })
      } catch {}
      
      let userId: string | undefined = undefined
      if (payerEmail) {
        try {
          const u = await prisma.user.findUnique({ where: { email: payerEmail } }) as User | null
          if (u) userId = u.id
        } catch {}
      }
      
      const ev = event.toLowerCase()
      const statusUpper = String(status).toUpperCase()
      const isPaid = ev === 'invoice.paid' || ['PAID','SETTLED','SUCCEEDED','SUCCESS'].includes(statusUpper)
      const isExpired = ev === 'invoice.expired' || statusUpper === 'EXPIRED'
      
      if (finalOrderId) {
        try {
          const order = await prisma.paymentLog.findUnique({ where: { orderId: finalOrderId } })
          if (order) {
            if (isPaid) {
              if (String(order.status).toUpperCase() !== 'PAID') {
                const amtOrder = num(order.amount)
                const amtWebhook = num(amount)
                const diff = Math.abs(amtOrder - amtWebhook)
                if (amtOrder === amtWebhook || diff <= 1000) {
                  await prisma.paymentLog.update({ where: { orderId: finalOrderId }, data: { status: 'PAID' } })
                  try {
                    const u = await prisma.user.findUnique({ where: { id: order.userId } })
                    if (u) {
                      const roles = new Set(u.roles || ['User'])
                      let p = String((order as any).plan || '').toLowerCase()
                      if (!p) {
                        const m = String(finalOrderId).match(/^invoice-([a-z0-9]+)-/)
                        if (m && m[1]) p = m[1]
                      }

                      const newExpiry = calculateNewExpiry((u as any).subscriptionExpiresAt, p)

                      if (p === 'creator') {
                        roles.add('Creator')
                        if (roles.has('Whitelist')) roles.delete('Whitelist')
                      } else {
                        roles.add('Trader')
                        if (roles.has('Whitelist')) roles.delete('Whitelist')
                      }
                      await prisma.user.update({ where: { id: u.id }, data: { roles: Array.from(roles), subscriptionExpiresAt: newExpiry } as Prisma.UserUpdateInput })
                    }
                  } catch {}
                } else {
                  console.error('Amount mismatch', { expected: order.amount, got: amount, orderId: finalOrderId })
                }
              }
            } else if (isExpired) {
              if (String(order.status).toUpperCase() !== 'PAID') {
                await prisma.paymentLog.update({ where: { orderId: finalOrderId }, data: { status: 'EXPIRED' } })
              }
            } else {
              await prisma.paymentLog.update({ where: { orderId: finalOrderId }, data: { status: status || order.status, amount: num(amount) || order.amount } })
            }
          } else if (userId) {
            const initialStatus = isPaid ? 'PAID' : (isExpired ? 'EXPIRED' : (status || 'PENDING'))
            const created = await prisma.paymentLog.create({ data: { orderId: finalOrderId, userId, amount: num(amount) || 0, status: initialStatus, createdAt: new Date() } })
            if (isPaid) {
              try {
                const u = await prisma.user.findUnique({ where: { id: userId } }) as User | null
                if (u) {
                  const roles = new Set(u.roles || ['User'])
                  let p = String((created as any).plan || '').toLowerCase()
                  if (!p) {
                    const m = String(finalOrderId).match(/^invoice-([a-z0-9]+)-/)
                    if (m && m[1]) p = m[1]
                  }

                  const newExpiry = calculateNewExpiry((u as any).subscriptionExpiresAt, p)

                  if (p === 'creator') {
                    roles.add('Creator')
                    if (roles.has('Whitelist')) roles.delete('Whitelist')
                  } else {
                    roles.add('Trader')
                    if (roles.has('Whitelist')) roles.delete('Whitelist')
                  }
                  await prisma.user.update({ where: { id: u.id }, data: { roles: Array.from(roles), subscriptionExpiresAt: newExpiry } as Prisma.UserUpdateInput })
                }
              } catch {}
            }
          } else {
            try {
              const since = new Date(Date.now() - 48 * 60 * 60 * 1000)
              const candidates = await prisma.paymentLog.findMany({
                where: { status: { not: 'PAID' }, createdAt: { gt: since } }
              })
              const matched = candidates.filter(c => {
                const d = Math.abs(num(c.amount) - num(amount))
                return d <= 1000
              })
              if (matched.length === 1) {
                const m = matched[0]
                if (isPaid) {
                  await prisma.paymentLog.update({ where: { orderId: m.orderId }, data: { status: 'PAID' } })
                  try {
                    const u = await prisma.user.findUnique({ where: { id: m.userId } }) as User | null
                    if (u) {
                      const roles = new Set(u.roles || ['User'])
                      let p = String((m as any).plan || '').toLowerCase()
                      if (!p) {
                        const prices = await prisma.pricing.findMany()
                        let bestPlan = ''
                        let bestDiff = Number.POSITIVE_INFINITY
                        for (const row of prices) {
                          const diff = Math.abs(num(row.currentIdr) - num(amount))
                          if (diff < bestDiff) {
                            bestDiff = diff
                            bestPlan = String(row.plan || '').toLowerCase()
                          }
                        }
                        p = bestPlan
                      }

                      const newExpiry = calculateNewExpiry((u as any).subscriptionExpiresAt, p)

                      if (p === 'creator') {
                        roles.add('Creator')
                        if (roles.has('Whitelist')) roles.delete('Whitelist')
                      } else {
                        roles.add('Trader')
                        if (roles.has('Whitelist')) roles.delete('Whitelist')
                      }
                      await prisma.user.update({ where: { id: u.id }, data: { roles: Array.from(roles), subscriptionExpiresAt: newExpiry } as Prisma.UserUpdateInput })
                    }
                  } catch {}
                } else if (isExpired) {
                  await prisma.paymentLog.update({ where: { orderId: m.orderId }, data: { status: 'EXPIRED' } })
                } else {
                  await prisma.paymentLog.update({ where: { orderId: m.orderId }, data: { status: status || m.status, amount: num(amount) || m.amount } })
                }
              }
            } catch {}
          }
        } catch (e) { console.error("Payment handling error:", e) }
      }
      
      const webhookUrl = process.env.DISCORD_WEBHOOK_URL || ''
      if (webhookUrl) {
        try {
          const content = [
            `Xendit Invoice: ${invoiceId || '-'}`,
            `External ID: ${finalOrderId || '-'}`,
            `Status: ${status || '-'}`,
            `Amount: Rp ${Math.round(amount).toLocaleString('id-ID')}`,
            `Payer: ${payerEmail || '-'}`,
            paymentId ? `Payment ID: ${paymentId}` : '',
            vaAccount ? `VA Account: ${vaAccount}` : '',
            bankCode ? `Bank: ${bankCode}` : '',
            merchantCode ? `Merchant: ${merchantCode}` : '',
            txTs ? `Timestamp: ${txTs}` : ''
          ].join('\n')
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content.trim() || `Xendit Update: ${finalOrderId || invoiceId || 'N/A'}` })
          }).then(async (resp) => {
            const txt = await resp.text()
            if (!resp.ok) {
              console.error('Discord webhook failed', { status: resp.status, body: txt })
            } else {
              console.log('Discord webhook sent', { status: resp.status })
            }
          }).catch((e) => {
            console.error('Discord webhook error', e)
          })
        } catch (e) { console.error("Discord webhook error:", e) }
      }
      
      res.status(200).json({ ok: true })
    } catch (e) {
      console.error("XENDIT WEBHOOK ERROR:", e)
      res.status(500).json({ error: 'xendit_webhook_error' })
    }
}

router.post('/xendit/webhook', xenditWebhook)

router.post('/midtrans/create', async (req, res) => {
  try {
    const { plan, email, couponCode } = req.body
    if (!plan || !email) return res.status(400).json({ error: 'missing_fields' })

    // Calculate amount (IDR)
    let amount = amountByPlanIDR(plan)
    const priceRow = await getPricing(String(plan))
    if (priceRow && num(priceRow.currentIdr) > 0) amount = num(priceRow.currentIdr)
    
    const key = String(couponCode || '').trim().toUpperCase()
    if (key) {
      try {
        const fromDb = await prisma.coupon.findUnique({ where: { code: key } })
        let rule: { percent?: number; amountOff?: number } | null = null
        if (fromDb && new Date(fromDb.expiresAt).getTime() > Date.now()) {
          rule = { percent: fromDb.percent || undefined, amountOff: fromDb.amountOff || undefined }
        }
        if (rule) {
          const pct = Number(rule.percent || 0)
          const offUsd = Number(rule.amountOff || 0)
          if (pct) amount = Math.max(0, amount * (1 - pct / 100))
          if (offUsd) amount = Math.max(0, amount - offUsd * 15000)
        }
      } catch {}
    }
    
    // Midtrans minimum 100 or something, let's say 10000
    if (amount < 1000) return res.status(400).json({ error: 'invalid_amount' })
    
    const serverKey = process.env.MIDTRANS_SERVER_KEY || ''
    const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true'
    
    if (!serverKey) {
        console.error("MIDTRANS SERVER KEY MISSING")
        return res.status(500).json({ error: 'midtrans_config_error' })
    }

    const snap = new midtransClient.Snap({
        isProduction,
        serverKey
    })

    const safePlan = String(plan || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '')
    const orderId = `midtrans-${safePlan}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    
    const parameter = {
        transaction_details: {
            order_id: orderId,
            gross_amount: amount
        },
        credit_card: {
            secure: true
        },
        customer_details: {
            email: email
        }
    }

    const transaction = await snap.createTransaction(parameter)
    
    // Create pending log
    try {
      const u = await prisma.user.findUnique({ where: { email } })
      if (u) {
          await (prisma as any).paymentLog.create({ 
              data: { 
                  orderId, 
                  userId: u.id, 
                  amount, 
                  status: 'PENDING', 
                  couponCode, 
                  plan, 
                  createdAt: new Date() 
              } 
          })
      }
    } catch (e) { console.error("Failed to create payment log", e) }

    res.json({ 
        redirect_url: transaction.redirect_url, 
        token: transaction.token,
        clientKey: process.env.MIDTRANS_CLIENT_KEY || '',
        isProduction
    })
  } catch (e: any) {
    console.error("MIDTRANS CREATE ERROR:", e)
    res.status(500).json({ error: e.message || 'midtrans_error' })
  }
})

router.post('/midtrans/webhook', async (req, res) => {
    try {
        const notificationJson = req.body
        const serverKey = process.env.MIDTRANS_SERVER_KEY || ''
        
        const apiClient = new midtransClient.Snap({
            isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
            serverKey: serverKey
        })

        const statusResponse = await apiClient.transaction.notification(notificationJson)
        await processMidtransStatus(statusResponse)

        res.status(200).json({ ok: true })
    } catch (e: any) {
        console.error("MIDTRANS WEBHOOK ERROR:", e)
        res.status(500).json({ error: e.message || 'midtrans_webhook_error' })
    }
})

router.get('/midtrans/check/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params
        const serverKey = process.env.MIDTRANS_SERVER_KEY || ''
        const apiClient = new midtransClient.Snap({
            isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
            serverKey: serverKey
        })
        
        // Get status from Midtrans
        const statusResponse = await apiClient.transaction.status(orderId)
        // Update DB
        await processMidtransStatus(statusResponse)
        
        const order = await prisma.paymentLog.findUnique({ where: { orderId } })
        res.json({ ok: true, status: order?.status, midtransStatus: statusResponse.transaction_status })
    } catch (e: any) {
        console.error("MIDTRANS CHECK ERROR:", e)
        res.status(500).json({ error: e.message })
    }
})

// Helper function to process status
export async function processMidtransStatus(statusResponse: any) {
    const orderId = statusResponse.order_id
    const transactionStatus = statusResponse.transaction_status
    const fraudStatus = statusResponse.fraud_status
    
    console.log(`Midtrans notification: ${orderId} ${transactionStatus} ${fraudStatus}`)

    let newStatus = 'PENDING'
    if (transactionStatus == 'capture') {
        if (fraudStatus == 'challenge') {
            newStatus = 'CHALLENGE'
        } else if (fraudStatus == 'accept') {
            newStatus = 'PAID'
        }
    } else if (transactionStatus == 'settlement') {
        newStatus = 'PAID'
    } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
        newStatus = 'FAILED'
    } else if (transactionStatus == 'pending') {
        newStatus = 'PENDING'
    }
    
    // Update database using transaction to ensure consistency
    await prisma.$transaction(async (tx) => {
        const order = await tx.paymentLog.findUnique({ where: { orderId } })
        if (!order) return

        // Check if we need to process payment (either new PAID status OR recovery for PAID status with missing role)
        const isNewPaid = newStatus === 'PAID' && order.status !== 'PAID'
        const isRecovery = newStatus === 'PAID' && order.status === 'PAID'

        if (isNewPaid || isRecovery) {
            // 1. Get User
            const u = await tx.user.findUnique({ where: { id: order.userId } }) as User | null
            
            if (u) {
                // Check if recovery is needed (skip if user already has role)
                let needsUpdate = isNewPaid
                if (isRecovery) {
                    const hasRole = u.roles.includes('Trader') || u.roles.includes('Creator')
                    if (!hasRole) needsUpdate = true
                }

                if (needsUpdate) {
                    // Update status if needed
                    if (order.status !== 'PAID') {
                        await tx.paymentLog.update({ where: { orderId }, data: { status: 'PAID' } })
                    }

                    // Grant roles
                    const roles = new Set(u.roles || ['User'])
                    let p = String((order as any).plan || '').toLowerCase()
                    
                    console.log(`[Midtrans] Granting role for order ${orderId}, user ${u.id}, plan ${p}`)

                    // Logic to extract plan from orderId if missing in DB
                    if (!p) {
                         const m = String(orderId).match(/^invoice-([a-z0-9]+)-/)
                         if (m && m[1]) p = m[1]
                         console.log(`[Midtrans] Plan extracted from orderId: ${p}`)
                    }

                    const newExpiry = calculateNewExpiry((u as any).subscriptionExpiresAt, p)

                    if (p === 'creator') {
                        roles.add('Creator')
                        if (roles.has('Whitelist')) roles.delete('Whitelist')
                    } else {
                        roles.add('Trader')
                        if (roles.has('Whitelist')) roles.delete('Whitelist')
                    }
                    
                    await tx.user.update({ 
                        where: { id: u.id }, 
                        data: { roles: Array.from(roles), subscriptionExpiresAt: newExpiry } as Prisma.UserUpdateInput
                    })
                    console.log(`[Midtrans] Role granted to user ${u.email} for plan ${p}. Roles: ${Array.from(roles)}`)
                }
            }
        } else if (newStatus !== 'PENDING' && newStatus !== order.status) {
            // Update other statuses (FAILED, EXPIRED, etc)
            await tx.paymentLog.update({ where: { orderId }, data: { status: newStatus } })
        }
    })

    // Discord Webhook
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL || ''
    if (webhookUrl) {
        try {
             const content = `Midtrans Update: ${orderId} - ${newStatus} (${transactionStatus})`
             await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
             })
        } catch {}
    }
    
    return { status: newStatus }
}

router.get('/midtrans/status/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params
        const serverKey = process.env.MIDTRANS_SERVER_KEY || ''
        const apiClient = new midtransClient.Snap({
            isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
            serverKey: serverKey
        })
        
        // Check status from Midtrans API
        const statusResponse = await apiClient.transaction.status(orderId)
        const result = await processMidtransStatus(statusResponse)
        
        res.json(result)
    } catch (e: any) {
        console.error("MIDTRANS STATUS CHECK ERROR:", e)
        res.status(500).json({ error: e.message })
    }
})

export default router
