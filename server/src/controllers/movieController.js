import { z } from 'zod';
import { prisma, transaction } from '../db.js';

const movieSchema = z.object({
  title: z.string().trim().min(1).max(200)
});

export async function listMovies(_req, res) {
  const movies = await prisma.movie.findMany({
    orderBy: { createdAt: 'desc' },
    include: { showSeats: { select: { status: true } } }
  });

  const response = movies.map(movie => ({
    id: movie.id,
    title: movie.title,
    created_at: movie.createdAt,
    seat_count: movie.showSeats.length,
    available_count: movie.showSeats.filter(seat => seat.status === 'AVAILABLE').length
  }));

  res.json(response);
}

export async function addMovie(req, res) {
  const { title } = movieSchema.parse(req.body);

  // Create the movie and its 100 seat-inventory rows together.
  const movie = await transaction(async tx => {
    const createdMovie = await tx.movie.create({
      data: { title, createdBy: req.user.id }
    });

    const inventory = Array.from({ length: 100 }, (_, index) => ({
      movieId: createdMovie.id,
      seatId: index + 1
    }));

    await tx.showSeat.createMany({ data: inventory });
    return createdMovie;
  });

  res.status(201).json({
    id: movie.id,
    title: movie.title,
    created_at: movie.createdAt
  });
}

export async function getMovieSeats(req, res) {
  const movie = await prisma.movie.findUnique({
    where: { id: req.params.id },
    select: { id: true }
  });

  if (!movie) {
    return res.status(404).json({ error: 'Movie or seat inventory not found' });
  }

  const inventory = await prisma.showSeat.findMany({
    where: { movieId: movie.id },
    include: {
      seat: true,
      hold: { select: { userId: true, status: true, expiresAt: true } }
    },
    orderBy: { seatId: 'asc' }
  });

  const now = Date.now();
  const response = inventory.map(item => {
    const hasActiveHold = item.hold?.status === 'ACTIVE'
      && item.hold.expiresAt.getTime() > now;
    const seatLabel = `${item.seat.rowLabel.trim()}${item.seat.seatNumber}`;
    const status = item.status === 'HELD' && !hasActiveHold
      ? 'AVAILABLE'
      : item.status;

    return {
      id: item.id,
      label: seatLabel,
      status,
      own_reservation: hasActiveHold && item.hold.userId === req.user?.id
        ? item.holdId
        : null,
      expires_at: hasActiveHold ? item.hold.expiresAt : null
    };
  });

  res.json(response);
}
