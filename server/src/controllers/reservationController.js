import { z } from 'zod';
import { prisma } from '../db.js';
import { emitSeatChange } from '../seatEvents.js';
import { reserve, pay } from '../reservations.js';

const reservationSchema = z.object({
  seatIds: z.array(z.string().regex(/^[A-J](10|[1-9])$/)).min(1).max(10),
  idempotencyKey: z.string().min(8).max(100)
});

const reservationDetails = {
  movie: { select: { title: true } },
  seats: {
    include: {
      showSeat: { include: { seat: true } }
    }
  }
};

function formatReservation(reservation) {
  return {
    id: reservation.id,
    movie_id: reservation.movieId,
    title: reservation.movie.title,
    status: reservation.status,
    expires_at: reservation.expiresAt,
    booking_reference: reservation.bookingReference,
    created_at: reservation.createdAt,
    amount: reservation.seats.reduce((total, item) => total + item.seatPrice, 0),
    seats: reservation.seats.map(item => {
      const seat = item.showSeat.seat;
      return `${seat.rowLabel.trim()}${seat.seatNumber}`;
    })
  };
}

export async function createReservation(req, res) {
  const body = reservationSchema.parse(req.body);
  const hasDuplicateSeats = new Set(body.seatIds).size !== body.seatIds.length;

  if (hasDuplicateSeats) {
    return res.status(400).json({ error: 'Duplicate seats are not allowed' });
  }

  const reservation = await reserve(
    req.user.id,
    req.params.id,
    body.seatIds,
    body.idempotencyKey,
    emitSeatChange,
    async (reservationId, delay) => {
      const { expiryQueue } = await import('../queue.js');
      await expiryQueue.add(
        'expire',
        { reservationId },
        { delay, jobId: `expire-${reservationId}`, removeOnComplete: true }
      );
    }
  );

  res.status(reservation.replay ? 200 : 201).json(reservation);
}

export async function payForReservation(req, res) {
  const result = await pay(req.user.id, req.params.id, emitSeatChange);
  res.json(result);
}

export async function listMyReservations(req, res) {
  const reservations = await prisma.reservation.findMany({
    where: { userId: req.user.id },
    include: reservationDetails,
    orderBy: { createdAt: 'desc' }
  });

  res.json(reservations.map(formatReservation));
}

export async function getMyReservation(req, res) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: reservationDetails
  });

  if (!reservation) {
    return res.status(404).json({ error: 'Reservation not found' });
  }

  res.json(formatReservation(reservation));
}
