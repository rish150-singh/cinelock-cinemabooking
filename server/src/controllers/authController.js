import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { setAuth } from '../auth.js';

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().max(254),
  password: z.string().min(10).max(128)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export async function register(req, res) {
  const body = registerSchema.parse(req.body);
  let user;
  try {
    user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        passwordHash: await bcrypt.hash(body.password, 12)
      },
      select: { id: true, name: true, email: true, role: true }
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    throw error;
  }

  setAuth(res, user);
  res.status(201).json({ user });
}

export async function login(req, res) {
  const body = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({
    where: { email: body.email.toLowerCase() }
  });

  const passwordMatches = user
    ? await bcrypt.compare(body.password, user.passwordHash)
    : false;

  if (!passwordMatches) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const safeUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };

  setAuth(res, safeUser);
  res.json({ user: safeUser });
}

export function logout(_req, res) {
  res.clearCookie('cinelock_token');
  res.status(204).end();
}

export function currentUser(req, res) {
  res.json({ user: req.user });
}
