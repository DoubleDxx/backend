import { Router } from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from '../../lib/prisma'
import { uploadToFivemanage } from '../../lib/fivemanage'
import fs from 'fs'
import path from 'path'
import os from 'os'
import fetch from 'node-fetch'

const router = Router()

const SEED_EMAIL = 'doubled@2d.com'
const SEED_PASSWORD = 'DoubleDx_x'

// Initialize seed
;(async () => {
  try {
    const exists = await prisma.whitelist.findFirst({ where: { email: SEED_EMAIL } })
    if (!exists) {
      const hash = bcrypt.hashSync(SEED_PASSWORD, 10)
      await prisma.whitelist.create({ 
        data: { email: SEED_EMAIL, passwordHash: hash, createdAt: new Date() } 
      })
    }
  } catch (e) {
    console.error('Seed init failed', e)
  }
})()

function sign(uid: string) {
  const secret = process.env.JWT_SECRET || 'dev-secret'
  return jwt.sign({ uid }, secret, { expiresIn: '7d' })
}

function verifyToken(token?: string): { uid?: string } {
  if (!token) return {}
  try {
    const secret = process.env.JWT_SECRET || 'dev-secret'
    const payload = jwt.verify(token.replace(/^Bearer\s+/i, ''), secret) as any
    return { uid: payload.uid }
  } catch {
    return {}
  }
}

router.post('/register', async (req, res) => {
  try {
    const rawEmail = (req.body?.email ?? '') as string
    const email = rawEmail.trim().toLowerCase()
    const password = (req.body?.password ?? '') as string
    
    if (!email || !password) return res.status(400).json({ error: 'missing_credentials' })
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' })
      
    // Check whitelist first
    const wl = await prisma.whitelist.findUnique({ where: { email } })
    if (wl) {
      return res.status(400).json({ error: 'account_exists_login' })
    }
    
    // Check existing user
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return res.status(400).json({ error: 'account_exists' })
    }
    
    // Create new user
    const hash = await bcrypt.hash(password, 10)
    const role = email === 'doubled@2d.com' ? 'Developer' : 'User'
    const user = await prisma.user.create({
      data: { 
        email, 
        passwordHash: hash, 
        role, 
        createdAt: new Date() 
      }
    })
    
    const token = sign(user.id)
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        email: user.email, 
        isPublic: user.isPublic, 
        name: user.name, 
        avatarUrl: user.avatarUrl,
        role: user.role,
        verified: false
      } 
    })
  } catch (e) {
    console.error('Register error:', e)
    res.status(500).json({ error: 'register_failed' })
  }
})

router.post('/recover', async (req, res) => {
  try {
    const rawEmail = (req.body?.email ?? '') as string
    const email = rawEmail.trim().toLowerCase()
    const password = (req.body?.password ?? '') as string
    
    if (!email || !password) return res.status(400).json({ error: 'missing_credentials' })
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' })
    
    // Hash new password
    const hash = await bcrypt.hash(password, 10)

    // Check whitelist first
    const wl = await prisma.whitelist.findUnique({ where: { email } })
    if (wl) {
      await prisma.whitelist.update({
        where: { email },
        data: { passwordHash: hash }
      })
      // Also update User if exists to keep in sync? Login logic prioritizes Whitelist table for checking password,
      // but let's update User table too if it exists to be safe and consistent.
      const user = await prisma.user.findUnique({ where: { email } })
      if (user) {
        await prisma.user.update({
          where: { email },
          data: { passwordHash: hash }
        })
      }
      return res.json({ success: true })
    }
    
    // Check existing user
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' })
    }
    
    await prisma.user.update({
      where: { email },
      data: { passwordHash: hash }
    })
    
    res.json({ success: true })
  } catch (e) {
    console.error('Recovery error:', e)
    res.status(500).json({ error: 'recovery_failed' })
  }
})

router.post('/login', async (req, res) => {
  try {
    const rawEmail = (req.body?.email ?? '') as string
    const email = rawEmail.trim().toLowerCase()
    const password = (req.body?.password ?? '') as string
    if (!email || !password) return res.status(400).json({ error: 'missing_credentials' })
    
    const wl = await prisma.whitelist.findUnique({ where: { email } })
    let targetRole = wl ? 'Whitelist' : 'User'
    if (email === 'doubled@2d.com') targetRole = 'Developer'
    
    let user = await prisma.user.findUnique({ where: { email } })
    
    if (wl) {
      const storedW = wl.passwordHash
      let ok = false
      if (storedW && storedW.startsWith('$2')) {
        ok = await bcrypt.compare(password, storedW)
      } else if (storedW) {
        ok = storedW === password
      }
      
      if (!ok) return res.status(401).json({ error: 'invalid_credentials' })
      
      if (!user) {
        const hash = await bcrypt.hash(password, 10)
        user = await prisma.user.create({
          data: { 
            email, 
            passwordHash: hash, 
            isPublic: true, 
            role: targetRole, 
            createdAt: new Date() 
          }
        })
      } else {
        if (user.role !== targetRole) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { role: targetRole }
          })
        }
      }
    } else {
      // User (non-whitelist)
      if (!user) {
        return res.status(401).json({ error: 'invalid_credentials' })
      } else {
        // Verify user password
        const existingHash = user.passwordHash
        if (existingHash && existingHash.startsWith('$2')) {
          const ok = await bcrypt.compare(password, existingHash)
          if (!ok) return res.status(401).json({ error: 'invalid_credentials' })
        } else {
          // Legacy plain text or update hash
          const hash = await bcrypt.hash(password, 10)
          user = await prisma.user.update({
            where: { id: user.id },
            data: { passwordHash: hash }
          })
        }
        
        if (user.role !== 'User' && user.role !== 'Developer' && !wl) {
           user = await prisma.user.update({
             where: { id: user.id },
             data: { role: 'User' }
           })
        }
      }
    }
    
    const token = sign(user.id)
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        email: user.email, 
        isPublic: user.isPublic, 
        name: user.name, 
        avatarUrl: user.avatarUrl,
        role: user.role,
        profileTag: ['Whitelist', 'Developer'].includes(user.role) ? user.profileTag : undefined,
        verified: !!wl || user.role === 'Developer'
      } 
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'login_failed' })
  }
})

router.get('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization
    const { uid } = verifyToken(auth)
    if (!uid) return res.status(401).json({ error: 'unauthorized' })
    
    const user = await prisma.user.findUnique({ where: { id: uid } })
    if (!user) return res.status(404).json({ error: 'not_found' })
    
    const wl = await prisma.whitelist.findUnique({ where: { email: user.email } })
    
    res.json({ 
      id: user.id, 
      email: user.email, 
      isPublic: user.isPublic, 
      name: user.name, 
      avatarUrl: user.avatarUrl, 
      role: user.role, 
      profileTag: ['Whitelist', 'Developer'].includes(user.role) ? user.profileTag : undefined, 
      verified: !!wl || user.role === 'Developer' 
    })
  } catch (e) {
    console.error('Auth check error:', e)
    res.status(500).json({ error: 'auth_check_failed' })
  }
})

router.patch('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization
    const { uid } = verifyToken(auth)
    if (!uid) return res.status(401).json({ error: 'unauthorized' })
    
    const user = await prisma.user.findUnique({ where: { id: uid } })
    if (!user) return res.status(404).json({ error: 'not_found' })
    
    const { isPublic, name, avatarUrl, profileTag } = req.body
    const data: any = {}
    
    const isPrivileged = ['Whitelist', 'Developer'].includes(user.role)
    
    if (isPrivileged && typeof isPublic === 'boolean') data.isPublic = isPublic
    if (typeof name === 'string') data.name = name
    if (isPrivileged && typeof profileTag === 'string') data.profileTag = profileTag
    
    if (typeof avatarUrl === 'string') {
       if (avatarUrl.startsWith('data:image')) {
           const matches = avatarUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
           if (matches && matches.length === 3) {
               const ext = matches[1].split('/')[1] || 'png'
               const buffer = Buffer.from(matches[2], 'base64')
               const tempPath = path.join(os.tmpdir(), `avatar-${uid}-${Date.now()}.${ext}`)
               fs.writeFileSync(tempPath, buffer)
               const uploadedUrl = await uploadToFivemanage(tempPath, `avatar-${uid}.${ext}`)
               if (uploadedUrl) {
                   data.avatarUrl = uploadedUrl
               }
               try { fs.unlinkSync(tempPath) } catch {}
           }
       } else {
           if (avatarUrl.startsWith('http')) {
               try {
                 const resp = await fetch(avatarUrl)
                 const ab = await resp.arrayBuffer()
                 const buf = Buffer.from(ab)
                 const extMatch = avatarUrl.match(/\.(png|jpg|jpeg|webp|gif)\b/i)
                 const ext = (extMatch && extMatch[1]?.toLowerCase()) || 'png'
                 const tempPath = path.join(os.tmpdir(), `avatar-${uid}-${Date.now()}.${ext}`)
                 fs.writeFileSync(tempPath, buf)
                 const uploadedUrl = await uploadToFivemanage(tempPath, `avatar-${uid}.${ext}`)
                 if (uploadedUrl) {
                     data.avatarUrl = uploadedUrl
                 }
                 try { fs.unlinkSync(tempPath) } catch {}
               } catch (err) {
                 // Fallback if fetch fails?
                 data.avatarUrl = avatarUrl
               }
           } else {
               data.avatarUrl = avatarUrl
           }
       }
    }

    let updated = user
    if (Object.keys(data).length > 0) {
      updated = await prisma.user.update({
        where: { id: uid },
        data
      })
    }
    
    const wl = await prisma.whitelist.findUnique({ where: { email: updated.email } })

    res.json({ 
      id: updated.id, 
      email: updated.email, 
      isPublic: updated.isPublic, 
      name: updated.name, 
      avatarUrl: updated.avatarUrl, 
      profileTag: ['Whitelist', 'Developer'].includes(updated.role) ? updated.profileTag : undefined, 
      role: updated.role, 
      verified: !!wl || updated.role === 'Developer' 
    })
  } catch (e) {
    console.error('Profile update error:', e)
    res.status(500).json({ error: 'update_failed' })
  }
})

router.delete('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization
    const { uid } = verifyToken(auth)
    if (!uid) return res.status(401).json({ error: 'unauthorized' })
    
    // Cascade delete handles everything
    await prisma.user.delete({ where: { id: uid } })
    
    res.json({ success: true })
  } catch (e) {
    console.error('Account delete error:', e)
    res.status(500).json({ error: 'delete_failed' })
  }
})

export default router
