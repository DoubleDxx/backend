import { prisma } from '../lib/prisma'

async function main() {
  console.log('Resetting data...')
  
  try {
    // Delete in reverse dependency order
    await prisma.screenshot.deleteMany({})
    await prisma.exitLeg.deleteMany({})
    await prisma.trade.deleteMany({})
    await prisma.note.deleteMany({})
    await prisma.walletTx.deleteMany({})
    
    await prisma.strategy.deleteMany({})
    await prisma.account.deleteMany({})
    await prisma.broker.deleteMany({})
    
    // We preserve Users and Whitelist to allow login
    console.log('Reset complete. (Users and Whitelist preserved)')
  } catch (e) {
    console.error('Reset failed:', e)
  } finally {
    await prisma.$disconnect()
  }
}

main()
