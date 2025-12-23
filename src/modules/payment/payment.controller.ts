import { Router } from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '../../lib/prisma'

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

router.post('/paypal/create', async (req, res) => {
  try {
    const clientId = process.env.PAYPAL_CLIENT_ID || ''
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET || ''
    const base = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com'
    const { amount = 5, currency = 'USD', description = 'Subscription' } = req.body || {}
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
    const base = amountByPlan(String(plan || ''))
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
    const allowed = requester && requester.roles.some(r => ['Developer', 'Creator'].includes(r))
    if (!allowed) return res.status(403).json({ error: 'forbidden_user' })
    
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
    const allowed = requester && requester.roles.some(r => ['Developer', 'Creator'].includes(r))
    if (!allowed || !requester) return res.status(403).json({ error: 'forbidden_user' })
    
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
    const allowed = requester && requester.roles.some(r => ['Developer', 'Creator'].includes(r))
    if (!allowed) return res.status(403).json({ error: 'forbidden_user' })
    
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

export default router
