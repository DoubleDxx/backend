import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    isPublic: boolean
    role?: 'Whitelist' | 'User' | 'Developer'
  }
}

export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1] // Bearer TOKEN

  if (!token) return res.status(401).json({ error: 'No token provided' })

  const secret = process.env.JWT_SECRET || 'dev-secret'

  try {
    const payload = jwt.verify(token, secret) as any
    const user = await prisma.user.findUnique({ where: { id: payload.uid } })
    
    if (!user) return res.status(403).json({ error: 'User not found' })

    ;(req as AuthRequest).user = {
      id: user.id,
      email: user.email,
      isPublic: user.isPublic,
      role: (user.role as 'Whitelist' | 'User' | 'Developer') || 'User'
    }
    next()
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' })
  }
}
