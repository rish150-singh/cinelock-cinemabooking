import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { auth, admin, optionalAuth } from '../auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as authController from '../controllers/authController.js';
import * as movieController from '../controllers/movieController.js';
import * as reservationController from '../controllers/reservationController.js';

const router = Router();

const authRateLimit = rateLimit({ windowMs: 60_000, limit: 20 });

// Authentication
router.post('/auth/register', authRateLimit, asyncHandler(authController.register));
router.post('/auth/login', authRateLimit, asyncHandler(authController.login));
router.post('/auth/logout', authController.logout);
router.get('/auth/me', auth, authController.currentUser);

// Movies and seat inventory
router.get('/movies', asyncHandler(movieController.listMovies));
router.post('/movies', auth, admin, asyncHandler(movieController.addMovie));
router.get('/movies/:id/seats', optionalAuth, asyncHandler(movieController.getMovieSeats));
router.post('/movies/:id/reservations', auth, asyncHandler(reservationController.createReservation));

// Reservations and booking history
router.post('/reservations/:id/pay', auth, asyncHandler(reservationController.payForReservation));
router.get('/my/reservations', auth, asyncHandler(reservationController.listMyReservations));
router.get('/reservations/:id', auth, asyncHandler(reservationController.getMyReservation));

export default router;
