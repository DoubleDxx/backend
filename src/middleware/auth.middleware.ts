import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma'
import { User } from '@prisma/client'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    isPublic: boolean
    roles: string[]
    subscriptionExpiresAt?: Date | null
  }
}

export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1] // Bearer TOKEN

  if (!token) return res.status(401).json({ error: 'No token provided' })

  const secret = process.env.JWT_SECRET || 'dev-secret'

  try {
    const payload = jwt.verify(token, secret) as any
    const user = await prisma.user.findUnique({ where: { id: payload.uid } }) as User | null
    
    if (!user) return res.status(403).json({ error: 'User not found' })

    let roles = user.roles || ['User']
    
    // Check expiration
    const u = user as any
    if (u.subscriptionExpiresAt && new Date(u.subscriptionExpiresAt) < new Date()) {
      // Expired: Remove premium roles
      roles = roles.filter(r => r !== 'Trader' && r !== 'Creator')
    }

    ;(req as AuthRequest).user = {
      id: user.id,
      email: user.email,
      isPublic: user.isPublic,
      roles: roles,
      subscriptionExpiresAt: u.subscriptionExpiresAt
    }
    next()
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' })
  }
}
