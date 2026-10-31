import './config/env.js';

import { PrismaClient } from '@prisma/client';

// Reuse one client so requests share Prisma's connection pool.
export const prisma = new PrismaClient();

export async function transaction(callback) {
  return prisma.$transaction(callback, {
    isolationLevel: 'ReadCommitted',
    maxWait: 5000,
    timeout: 10000
  });
}
