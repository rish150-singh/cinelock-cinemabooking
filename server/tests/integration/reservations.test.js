import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/db.js';
import { reserve, pay, expireReservation } from '../../src/reservations.js';

const emit = () => {};
const enqueue = async () => {};
let userA;
let userB;
const movieIds = [];

async function inventory() {
  const movie = await prisma.movie.create({ data: { title: `Prisma concurrency test ${randomUUID()}` } });
  movieIds.push(movie.id);
  await prisma.showSeat.createMany({ data: Array.from({ length: 100 }, (_, index) => ({ movieId: movie.id, seatId: index + 1 })) });
  return movie.id;
}

beforeAll(async () => {
  const a = await prisma.user.create({ data: { name: 'Test A', email: `a-${randomUUID()}@test.invalid`, passwordHash: 'test' } });
  const b = await prisma.user.create({ data: { name: 'Test B', email: `b-${randomUUID()}@test.invalid`, passwordHash: 'test' } });
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  if (movieIds.length) {
    const reservations = await prisma.reservation.findMany({ where: { movieId: { in: movieIds } }, select: { id: true } });
    const ids = reservations.map(item => item.id);
    await prisma.payment.deleteMany({ where: { reservationId: { in: ids } } });
    await prisma.reservationSeat.deleteMany({ where: { reservationId: { in: ids } } });
    await prisma.showSeat.updateMany({ where: { movieId: { in: movieIds } }, data: { holdId: null } });
    await prisma.showSeat.deleteMany({ where: { movieId: { in: movieIds } } });
    await prisma.reservation.deleteMany({ where: { movieId: { in: movieIds } } });
    await prisma.movie.deleteMany({ where: { id: { in: movieIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test.invalid' } } });
  await prisma.$disconnect();
});

describe('PostgreSQL reservation invariants (requires a migrated test database)', () => {
  it('allows exactly one simultaneous request for the same seats', async () => {
    const movieId = await inventory();
    const requests = await Promise.allSettled([
      reserve(userA, movieId, ['A1', 'A2'], `same-a-${randomUUID()}`, emit, enqueue),
      reserve(userB, movieId, ['A1', 'A2'], `same-b-${randomUUID()}`, emit, enqueue)
    ]);
    expect(requests.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(requests.filter(item => item.status === 'rejected' && item.reason.status === 409)).toHaveLength(1);
  });

  it('allows disjoint reservations concurrently', async () => {
    const movieId = await inventory();
    const [a, b] = await Promise.all([
      reserve(userA, movieId, ['A1', 'A2'], `disjoint-a-${randomUUID()}`, emit, enqueue),
      reserve(userB, movieId, ['B1', 'B2'], `disjoint-b-${randomUUID()}`, emit, enqueue)
    ]);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects overlapping multi-seat requests without holding the free seat', async () => {
    const movieId = await inventory();
    await reserve(userA, movieId, ['A1'], `overlap-a-${randomUUID()}`, emit, enqueue);
    await expect(reserve(userB, movieId, ['A1', 'A2'], `overlap-b-${randomUUID()}`, emit, enqueue)).rejects.toMatchObject({ status: 409 });
    const seat = await prisma.showSeat.findFirst({ where: { movieId, seat: { rowLabel: 'A', seatNumber: 2 } }, select: { status: true } });
    expect(seat.status).toBe('AVAILABLE');
  });

  it('returns the original reservation for an idempotent retry', async () => {
    const movieId = await inventory();
    const key = `retry-${randomUUID()}`;
    const first = await reserve(userA, movieId, ['C1'], key, emit, enqueue);
    const again = await reserve(userA, movieId, ['C1'], key, emit, enqueue);
    expect(again.id).toBe(first.id);
    expect(again.replay).toBe(true);
  });

  it('expires a hold and rejects payment after its deadline', async () => {
    const movieId = await inventory();
    const hold = await reserve(userA, movieId, ['D1'], `expired-${randomUUID()}`, emit, enqueue);
    await prisma.reservation.update({ where: { id: hold.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(pay(userA, hold.id, emit)).rejects.toMatchObject({ status: 410 });
    expect(await expireReservation(hold.id, emit)).toBe(false);
    const seat = await prisma.showSeat.findFirst({ where: { movieId, seat: { rowLabel: 'D', seatNumber: 1 } }, select: { status: true } });
    expect(seat.status).toBe('AVAILABLE');
  });
});
