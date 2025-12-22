import { Router } from 'express'
import fetch from 'node-fetch'
import crypto from 'crypto'

const router = Router()

function num(v: any): number { const n = Number(v); return isNaN(n) ? 0 : n }

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

router.post('/midtrans/create', async (req, res) => {
  try {
    const serverKey = process.env.MIDTRANS_SERVER_KEY || ''
    const snapBase = process.env.MIDTRANS_BASE_URL || 'https://app.sandbox.midtrans.com'
    const { order_id, amount = 75000, customer = {}, items = [] } = req.body || {}
    const auth = Buffer.from(`${serverKey}:`).toString('base64')
    const body = {
      transaction_details: { order_id: order_id || `order-${Date.now()}`, gross_amount: num(amount) },
      customer_details: customer,
      item_details: Array.isArray(items) ? items : []
    }
    const resp = await fetch(`${snapBase}/snap/v1/transactions`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const json: any = await resp.json()
    if (!resp.ok) return res.status(500).json({ error: 'midtrans_create_failed', details: json })
    res.json({ token: json.token, redirect_url: json.redirect_url })
  } catch (e) {
    res.status(500).json({ error: 'midtrans_error' })
  }
})

router.post('/midtrans/webhook', async (req, res) => {
  try {
    const serverKey = process.env.MIDTRANS_SERVER_KEY || ''
    const { order_id, status_code, gross_amount, signature_key } = req.body || {}
    const raw = String(order_id) + String(status_code) + String(gross_amount) + String(serverKey)
    const calc = crypto.createHash('sha512').update(raw).digest('hex')
    if (String(calc) !== String(signature_key)) return res.status(403).json({ error: 'invalid_signature' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'midtrans_webhook_error' })
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
