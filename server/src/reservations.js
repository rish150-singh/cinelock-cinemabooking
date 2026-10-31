import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, transaction } from './db.js';


/*

Yes, roughly. tx is a variable that gives the function access to the database through the current transaction.

It’s not a different database. It’s a transaction-scoped Prisma client:
- Use prisma for regular queries.
- Use tx inside transaction(async tx => { ... }) when several queries must succeed or fail together.
The name tx is just a convention; it could be called transactionClient instead.

*/

const reservationWithSeats = {
  seats: {
    include: {
      showSeat: { include: { seat: true } }
    }
  }
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function formatSeatLabel(seat) {
  return `${seat.rowLabel.trim()}${seat.seatNumber}`;
}

function formatExistingReservation(reservation) {
  return {
    id: reservation.id,
    status: reservation.status,
    expires_at: reservation.expiresAt,
    movie_id: reservation.movieId,
    seats: reservation.seats.map(item => formatSeatLabel(item.showSeat.seat))
  };
}

function toSeatNumbers(seatLabels) {
  return seatLabels.map(label => {
    const rowIndex = label.charCodeAt(0) - 'A'.charCodeAt(0);
    const seatNumber = Number(label.slice(1));
    return rowIndex * 10 + seatNumber;
  });
}

async function findExistingReservation(tx, userId, idempotencyKey) {
  return tx.reservation.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    include: reservationWithSeats
  });
}

async function lockReservationsForHeldSeats(tx, movieId, seatNumbers) {
  // Lock existing reservation rows first. Pay and expiry use the same lock order.
  const heldRows = await tx.$queryRaw`
    SELECT DISTINCT hold_id
    FROM show_seats
    WHERE movie_id = ${movieId}::uuid
      AND seat_id IN (${Prisma.join(seatNumbers)})
      AND status = 'HELD'
      AND hold_id IS NOT NULL
    ORDER BY hold_id`;

  if (heldRows.length === 0) return;

  const holdIds = heldRows.map(row => row.hold_id);
  await tx.$queryRaw`
    SELECT id
    FROM reservations
    WHERE id IN (${Prisma.join(holdIds)})
    ORDER BY id
    FOR UPDATE`;
}

async function lockRequestedSeats(tx, movieId, seatNumbers) {
  // The database locks these rows until the transaction commits or rolls back.
  return tx.$queryRaw`
    SELECT ss.id, ss.seat_id, ss.status, ss.hold_id, s.row_label, s.seat_number
    FROM show_seats AS ss
    JOIN seats AS s ON s.id = ss.seat_id
    WHERE ss.movie_id = ${movieId}::uuid
      AND ss.seat_id IN (${Prisma.join(seatNumbers)})
    ORDER BY ss.id
    FOR UPDATE OF ss`;
}

async function reclaimExpiredHolds(tx, lockedSeats) {
  const heldReservationIds = [
    ...new Set(lockedSeats.filter(seat => seat.status === 'HELD').map(seat => seat.hold_id))
  ];
  const reclaimedReservationIds = new Set();

  for (const reservationId of heldReservationIds) {
    // The database clock decides whether the five-minute hold has expired.
    const updatedCount = await tx.$executeRaw`
      UPDATE reservations
      SET status = 'EXPIRED'
      WHERE id = ${reservationId}::uuid
        AND status = 'ACTIVE'
        AND expires_at <= now()`;

    if (updatedCount === 0) continue;

    // Only release seats that are still held by this exact reservation.
    await tx.showSeat.updateMany({
      where: { holdId: reservationId, status: 'HELD' },
      data: { status: 'AVAILABLE', holdId: null }
    });
    reclaimedReservationIds.add(reservationId);
  }

  return reclaimedReservationIds;
}

function assertAllSeatsAvailable(lockedSeats, reclaimedReservationIds) {
  const unavailableSeats = lockedSeats.filter(seat =>
    seat.status !== 'AVAILABLE' && !reclaimedReservationIds.has(seat.hold_id)
  );

  if (unavailableSeats.length === 0) return;

  const labels = unavailableSeats.map(seat => `${seat.row_label.trim()}${seat.seat_number}`);
  throw new HttpError(409, `Unavailable seats: ${labels.join(', ')}`);
}

async function createReservationAndHoldSeats(tx, { userId, movieId, idempotencyKey, requestedSeatLabels, lockedSeats }) {
  const expiryRows = await tx.$queryRaw`
    SELECT now() + interval '5 minutes' AS expires_at`;
  const expiresAt = expiryRows[0].expires_at;

  const reservation = await tx.reservation.create({
    data: { userId, movieId, status: 'ACTIVE', expiresAt, idempotencyKey }
  });

  const showSeatIds = lockedSeats.map(seat => seat.id);
  await tx.reservationSeat.createMany({
    data: showSeatIds.map(showSeatId => ({ reservationId: reservation.id, showSeatId }))
  });

  await tx.showSeat.updateMany({
    where: { id: { in: showSeatIds } },
    data: { status: 'HELD', holdId: reservation.id }
  });

  return {
    id: reservation.id,
    status: reservation.status,
    expires_at: reservation.expiresAt,
    movie_id: movieId,
    seats: requestedSeatLabels
  };
}

export async function reserve(userId, movieId, requestedSeatLabels, idempotencyKey, publish, enqueue) {
  const seatLabels = [...new Set(requestedSeatLabels)].sort((a, b) => a.localeCompare(b));
  const seatNumbers = toSeatNumbers(seatLabels);
  let outcome;

  try {
    outcome = await transaction(async tx => {
      const previousReservation = await findExistingReservation(tx, userId, idempotencyKey);
      if (previousReservation) {
        return { replay: true, reservation: formatExistingReservation(previousReservation) };
      }

      await lockReservationsForHeldSeats(tx, movieId, seatNumbers);
      const lockedSeats = await lockRequestedSeats(tx, movieId, seatNumbers);

      if (lockedSeats.length !== seatNumbers.length) {
        throw new HttpError(400, 'One or more seats are invalid for this movie');
      }

      const reclaimedIds = await reclaimExpiredHolds(tx, lockedSeats);
      assertAllSeatsAvailable(lockedSeats, reclaimedIds);

      const reservation = await createReservationAndHoldSeats(tx, {
        userId,
        movieId,
        idempotencyKey,
        requestedSeatLabels: seatLabels,
        lockedSeats
      });

      return { replay: false, reservation };
    });
  } catch (error) {
    // Concurrent retries with the same key are resolved by the database unique constraint.
    if (error.code === 'P2002') {
      const previousReservation = await findExistingReservation(prisma, userId, idempotencyKey);
      if (previousReservation) {
        return { ...formatExistingReservation(previousReservation), replay: true };
      }
    }
    throw error;
  }

  if (outcome.replay) return { ...outcome.reservation, replay: true };

  // Notify clients and schedule cleanup only after the database transaction commits.
  publish({ movieId, seatIds: outcome.reservation.seats, status: 'HELD' });
  const delay = Math.max(0, new Date(outcome.reservation.expires_at).getTime() - Date.now());
  await enqueue(outcome.reservation.id, delay);

  return { ...outcome.reservation, replay: false };
}

async function releaseReservationSeats(tx, reservationId) {
  const reservationSeats = await tx.reservationSeat.findMany({
    where: { reservationId },
    include: { showSeat: { include: { seat: true } } }
  });

  await tx.showSeat.updateMany({
    where: { holdId: reservationId, status: 'HELD' },
    data: { status: 'AVAILABLE', holdId: null }
  });

  return reservationSeats.map(item => formatSeatLabel(item.showSeat.seat));
}

export async function expireReservation(reservationId, publish) {
  const expiredReservation = await transaction(async tx => {
    const rows = await tx.$queryRaw`
      SELECT id, movie_id
      FROM reservations
      WHERE id = ${reservationId}::uuid
        AND status = 'ACTIVE'
        AND expires_at <= now()
      FOR UPDATE`;

    if (rows.length === 0) return null;

    const seats = await releaseReservationSeats(tx, reservationId);
    await tx.reservation.update({ where: { id: reservationId }, data: { status: 'EXPIRED' } });

    return { movieId: rows[0].movie_id, seats };
  });

  if (!expiredReservation) return false;

  publish({ movieId: expiredReservation.movieId, seatIds: expiredReservation.seats, status: 'AVAILABLE' });
  return true;
}

async function lockOwnedReservation(tx, userId, reservationId) {
  const rows = await tx.$queryRaw`
    SELECT *
    FROM reservations
    WHERE id = ${reservationId}::uuid AND user_id = ${userId}::uuid
    FOR UPDATE`;

  if (rows.length === 0) throw new HttpError(404, 'Reservation not found');
  return rows[0];
}

async function expireIfPastDeadline(tx, reservation) {
  const deadline = await tx.$queryRaw`
    SELECT ${reservation.expires_at}::timestamptz > now() AS active`;
  if (deadline[0].active) return null;

  const seats = await releaseReservationSeats(tx, reservation.id);
  await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'EXPIRED' } });
  return { expired: true, movieId: reservation.movie_id, seats };
}

async function lockAndValidateReservationSeats(tx, reservationId) {
  const seats = await tx.$queryRaw`
    SELECT ss.id, ss.status, ss.hold_id, s.row_label, s.seat_number
    FROM reservation_seats AS rs
    JOIN show_seats AS ss ON ss.id = rs.show_seat_id
    JOIN seats AS s ON s.id = ss.seat_id
    WHERE rs.reservation_id = ${reservationId}::uuid
    ORDER BY ss.id
    FOR UPDATE OF ss`;

  const seatsStillHeld = seats.every(seat => seat.status === 'HELD' && seat.hold_id === reservationId);
  if (!seatsStillHeld) throw new HttpError(409, 'Reservation seats are no longer held');
  return seats;
}

async function confirmPayment(tx, reservation, lockedSeats) {
  const bookingReference = `CL-${randomBytes(5).toString('hex').toUpperCase()}`;
  const paymentReference = `SIM-${randomBytes(8).toString('hex').toUpperCase()}`;
  const price = await tx.reservationSeat.aggregate({
    where: { reservationId: reservation.id },
    _sum: { seatPrice: true }
  });

  await tx.reservation.update({
    where: { id: reservation.id },
    data: { status: 'CONFIRMED', confirmedAt: new Date(), bookingReference }
  });
  await tx.showSeat.updateMany({
    where: { holdId: reservation.id, status: 'HELD' },
    data: { status: 'BOOKED', holdId: null }
  });
  await tx.payment.create({
    data: {
      reservationId: reservation.id,
      status: 'SUCCEEDED',
      amount: price._sum.seatPrice ?? 0,
      paymentReference
    }
  });

  return {
    already: false,
    expired: false,
    reference: bookingReference,
    payment: paymentReference,
    movieId: reservation.movie_id,
    seats: lockedSeats.map(seat => `${seat.row_label.trim()}${seat.seat_number}`)
  };
}

export async function pay(userId, reservationId, publish) {
  const result = await transaction(async tx => {
    const reservation = await lockOwnedReservation(tx, userId, reservationId);

    if (reservation.status === 'CONFIRMED') {
      const payment = await tx.payment.findUnique({ where: { reservationId } });
      return {
        already: true,
        expired: false,
        reference: reservation.booking_reference,
        payment: payment?.paymentReference,
        movieId: reservation.movie_id,
        seats: []
      };
    }

    if (reservation.status !== 'ACTIVE') {
      return { expired: true, movieId: reservation.movie_id, seats: [] };
    }

    const expired = await expireIfPastDeadline(tx, reservation);
    if (expired) return expired;

    const lockedSeats = await lockAndValidateReservationSeats(tx, reservationId);
    return confirmPayment(tx, reservation, lockedSeats);
  });

  if (result.expired) {
    if (result.seats.length) publish({ movieId: result.movieId, seatIds: result.seats, status: 'AVAILABLE' });
    throw new HttpError(410, 'Reservation has expired');
  }

  if (!result.already) publish({ movieId: result.movieId, seatIds: result.seats, status: 'BOOKED' });
  return result;
}
