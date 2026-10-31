import bcrypt from 'bcryptjs';
import { prisma } from './db.js';

const email = (process.env.ADMIN_EMAIL ?? 'admin@cinelock.local').toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 12) {
  throw new Error('Set ADMIN_PASSWORD to a value at least 12 characters long in .env');
}

try {
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      name: process.env.ADMIN_NAME ?? 'CineLock Admin',
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'ADMIN'
    }
  });
  console.log(`Admin provisioned if absent: ${email}`);
} finally {
  await prisma.$disconnect();
}
