import jwt from 'jsonwebtoken';
import { prisma } from './db.js';

const secret = () => {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters');
  return value;
};

export function setAuth(res, user) {
  const token = jwt.sign({ sub: user.id }, secret(), { expiresIn: '7d' });
  res.cookie('cinelock_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

export async function auth(req, res, next) {
  try {
    const token = req.cookies?.cinelock_token ;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const payload = jwt.verify(token, secret());
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, name: true, email: true, role: true } });
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export async function optionalAuth(req, _res, next) {
  try {
    const token = req.cookies?.cinelock_token ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    if (!token) return next();
    const payload = jwt.verify(token, secret());
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, name: true, email: true, role: true } });
    if (user) req.user = user;
  } catch { /* Public inventory remains readable with an expired cookie. */ }
  next();
}

export function admin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  next();
}
