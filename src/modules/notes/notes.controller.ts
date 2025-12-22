import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../../lib/prisma'

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

router.get('/', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { from, to, limit } = req.query as any
    
    const notes = await prisma.note.findMany({
        where: {
            userId: user.id,
            date: {
                gte: from ? new Date(from) : undefined,
                lte: to ? new Date(to) : undefined
            }
        },
        orderBy: { date: 'desc' },
        take: limit ? Number(limit) : undefined,
        include: { strategy: true }
    })
    
    const mapped = notes.map(n => {
        return {
            id: n.id,
            date: n.date.toISOString(),
            note: n.content,
            strategy_id: n.strategyId,
            strategy_name: n.strategy?.name
        }
    })
    
    res.json(mapped)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed_fetch_notes' })
  }
})

router.post('/', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { date, note, strategy_id } = req.body
    
    if (!date || !note) return res.status(400).json({ error: 'missing_fields' })
    
    const newNote = await prisma.note.create({
        data: {
            userId: user.id,
            date: new Date(date),
            content: note,
            strategyId: strategy_id || null
        }
    })
    
    res.json({ id: newNote.id })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'failed_create_note' })
  }
})

export default router
