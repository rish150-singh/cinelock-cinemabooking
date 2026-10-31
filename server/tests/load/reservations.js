import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// Count expected booking conflicts separately from other HTTP failures.
const reservationConflicts = new Counter('reservation_conflicts');

const baseUrl = __ENV.BASE_URL || 'http://localhost:4000';
const movieId = __ENV.MOVIE_ID;
const seatIds = (__ENV.SEAT_IDS || 'A1,A2')
  .split(',')
  .map(seatId => seatId.trim())
  .filter(Boolean);

// k6 runs this many virtual users for the configured duration.
export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    // Treat a p95 response time over 1.5 seconds as a failed load run.
    http_req_duration: ['p(95)<1500']
  }
};

function requireLoadTestConfiguration() {
  if (!__ENV.EMAIL || !__ENV.PASSWORD) {
    throw new Error('Set EMAIL and PASSWORD to an existing CineLock account.');
  }

  if (!movieId) {
    throw new Error('Set MOVIE_ID to an existing movie UUID.');
  }

  if (seatIds.length === 0) {
    throw new Error('SEAT_IDS must contain one or more seat labels, such as A1,A2.');
  }
}

function login() {
  const response = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({ email: __ENV.EMAIL, password: __ENV.PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(response, {
    'login returned HTTP 200': result => result.status === 200
  });

  // The API sets this HTTP-only cookie. The server also accepts it as a Bearer token.
  const token = response.cookies?.cinelock_token?.[0]?.value;
  if (!token) {
    throw new Error('Login did not return the cinelock_token cookie.');
  }

  return token;
}

// setup() runs once before the virtual users start. Each VU receives the token.
export function setup() {
  requireLoadTestConfiguration();
  return { token: login() };
}

function createIdempotencyKey() {
  // Each request gets its own key so retries do not collapse into one reservation.
  return `k6-${__VU}-${__ITER}-${Date.now()}`;
}

function requestReservation(token) {
  const payload = {
    seatIds,
    idempotencyKey: createIdempotencyKey()
  };

  return http.post(
    `${baseUrl}/api/movies/${movieId}/reservations`,
    JSON.stringify(payload),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    }
  );
}

// k6 calls this repeatedly for each virtual user during the test duration.
export default function (data) {
  const response = requestReservation(data.token);

  if (response.status === 409) {
    reservationConflicts.add(1);
  }

  check(response, {
    'reservation succeeded or correctly conflicted': result =>
      result.status === 201 || result.status === 409
  });
}
