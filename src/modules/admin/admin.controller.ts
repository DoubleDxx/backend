import { Router } from 'express'
import bcrypt from 'bcrypt'
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

router.post('/whitelist', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    if (!user.roles.includes('Developer')) return res.status(403).json({ error: 'forbidden' })

    const rawEmail = (req.body?.email ?? '') as string
    const email = rawEmail.trim().toLowerCase()
    const password = (req.body?.password ?? '') as string
    const role = (req.body?.role ?? 'Whitelist') as string

    if (!email || !password) return res.status(400).json({ error: 'missing_fields' })
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' })

    // Check if exists in whitelist
    const existing = await prisma.whitelist.findUnique({ where: { email } })
    if (existing) return res.status(400).json({ error: 'already_whitelisted' })

    const hash = await bcrypt.hash(password, 10)
    
    // Add to Whitelist table (gatekeeper)
    await prisma.whitelist.create({
      data: {
        email,
        passwordHash: hash,
        createdAt: new Date()
      }
    })

    // Also ensure User record exists with correct role
    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (!existingUser) {
        await prisma.user.create({
            data: {
                email,
                passwordHash: hash,
                isPublic: true,
                roles: ['User', role],
                createdAt: new Date()
            }
        })
    } else {
        // If user exists, add the role
        const newRoles = new Set(existingUser.roles)
        newRoles.add(role)
        // If adding Trader or Creator, maybe remove Whitelist if we want mutual exclusivity? 
        // But for now let's just add. The login logic will handle not re-adding Whitelist if Trader exists.
        if ((role === 'Trader' || role === 'Creator') && newRoles.has('Whitelist')) {
            newRoles.delete('Whitelist')
        }
        
        await prisma.user.update({
            where: { email },
            data: { roles: Array.from(newRoles) }
        })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Add whitelist failed:', e)
    res.status(500).json({ error: 'failed' })
  }
})

router.delete('/users/:id', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user || !user.roles.includes('Developer')) return res.status(403).json({ error: 'forbidden' })

    const { id } = req.params
    // Prevent deleting self
    if (id === user.id) return res.status(400).json({ error: 'cannot_delete_self' })

    await prisma.user.delete({ where: { id } })
    res.json({ ok: true })
  } catch (e) {
    console.error('Delete user failed:', e)
    res.status(500).json({ error: 'failed' })
  }
})

router.put('/users/:id/role', async (req, res) => {
  try {
    const user = await ensureUser(req)
    if (!user || !user.roles.includes('Developer')) return res.status(403).json({ error: 'forbidden' })

    const { id } = req.params
    const { role, roles } = req.body

    // Support both single role and multiple roles update
    let finalRoles: string[] = []
    if (roles && Array.isArray(roles)) {
      finalRoles = roles
    } else if (role) {
      finalRoles = [role]
    } else {
      return res.status(400).json({ error: 'missing_role' })
    }

    await prisma.user.update({
      where: { id },
      data: { roles: finalRoles }
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('Update role failed:', e)
    res.status(500).json({ error: 'failed' })
  }
})

export default router
