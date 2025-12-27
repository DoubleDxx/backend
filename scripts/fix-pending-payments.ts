
import { PrismaClient } from '@prisma/client'
import fetch from 'node-fetch'

const prisma = new PrismaClient()

async function main() {
  console.log('Checking pending payments...')
  
  const pending = await prisma.paymentLog.findMany({
    where: { status: 'PENDING' }
  })
  
  console.log(`Found ${pending.length} pending payments.`)
  
  for (const p of pending) {
    if (!p.orderId.startsWith('invoice-') && !p.orderId.startsWith('midtrans-')) {
        console.log(`Skipping non-invoice order: ${p.orderId}`)
        continue
    }

    console.log(`Checking ${p.orderId}...`)
    try {
      const res = await fetch(`http://localhost:4000/api/payment/midtrans/status/${p.orderId}`)
      const json = await res.json()
      console.log(`Result for ${p.orderId}:`, json)
    } catch (e) {
      console.error(`Failed to check ${p.orderId}:`, e)
    }
  }
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect())
