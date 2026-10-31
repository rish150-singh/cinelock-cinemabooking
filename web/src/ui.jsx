import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const API = 'http://localhost:4000/api';
const SOCKET_URL = 'http://localhost:4000';
const PRICE_CENTS = 1200;

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });

  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function AuthScreen({ mode, setMode, onSubmit, message }) {
  return (
    <main className="auth-page">
      <section className="panel auth-panel">
        <span className="brand">CineLock</span>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="muted">Book a seat for your next movie night.</p>

        <form className="form" onSubmit={onSubmit}>
          {mode === 'register' && (
            <label>Name<input name="name" autoComplete="name" required /></label>
          )}
          <label>Email<input name="email" type="email" autoComplete="email" required /></label>
          <label>
            Password
            <input
              name="password"
              type="text"
              minLength={mode === 'register' ? 10 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </label>
          <button className="button primary" type="submit">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          className="link-button"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'New to CineLock? Create an account' : 'Already registered? Sign in'}
        </button>
        {message && <p className="message error">{message}</p>}
      </section>
    </main>
  );
}

function SeatGrid({ seats, selected, onToggle }) {
  function stateFor(label) {
    const seat = seats.find(item => item.label === label);
    if (seat?.status === 'BOOKED') return 'booked';
    if (seat?.status === 'HELD') return seat.own_reservation ? 'mine' : 'held';
    return selected.includes(label) ? 'selected' : 'available';
  }

  return (
    <div className="seat-grid" aria-label="Movie seats">
      {'ABCDEFGHIJ'.split('').map(row => (
        <div className="seat-row" key={row}>
          <span className="row-label">{row}</span>
          {Array.from({ length: 10 }, (_, index) => {
            const label = `${row}${index + 1}`;
            const state = stateFor(label);
            const disabled = ['booked', 'held', 'mine'].includes(state);

            return (
              <button
                key={label}
                className={`seat ${state}`}
                title={`${label}: ${state}`}
                aria-label={`${label}, ${state}`}
                aria-pressed={state === 'selected'}
                disabled={disabled}
                onClick={() => onToggle(label)}
              >
                {index + 1}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function StatusLegend() {
  return (
    <div className="legend">
      <span><i className="available" />Available</span>
      <span><i className="selected" />Selected</span>
      <span><i className="held" />Held</span>
      <span><i className="booked" />Booked</span>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [movies, setMovies] = useState([]);
  const [movie, setMovie] = useState(null);
  const [seats, setSeats] = useState([]);
  const [selected, setSelected] = useState([]);
  const [page, setPage] = useState('movies');
  const [booking, setBooking] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [mode, setMode] = useState('login');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const total = selected.length * PRICE_CENTS;

  async function refreshMovies() {
    setMovies(await api('/movies'));
  }

  async function refreshSeats(movieId) {
    setSeats(await api(`/movies/${movieId}/seats`));
  }

  useEffect(() => {
    api('/auth/me').then(result => setUser(result.user)).catch(() => {});
    refreshMovies().catch(() => {});
  }, []);

  useEffect(() => {
    if (!movie) return undefined;

    const refresh = () => refreshSeats(movie.id).catch(() => {});
    const socket = io(SOCKET_URL, { withCredentials: true });

    refresh();
    socket.on('connect', () => {
      socket.emit('movie:join', movie.id);
      refresh();
    });
    socket.on('seats:changed', refresh);

    return () => {
      socket.emit('movie:leave', movie.id);
      socket.disconnect();
    };
  }, [movie?.id]);

  useEffect(() => {
    if (!booking || booking.status !== 'ACTIVE') return undefined;

    function updateCountdown() {
      const remaining = new Date(booking.expires_at).getTime() - Date.now();
      setSecondsLeft(Math.max(0, Math.ceil(remaining / 1000)));
    }

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [booking]);

  async function submitAuth(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    try {
      const result = await api(`/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form))
      });
      setUser(result.user);
      setMessage('');
    } catch (error) {
      setMessage(error.message);
    }
  }

  function openMovie(selectedMovie) {
    setMovie(selectedMovie);
    setSelected([]);
    setMessage('');
  }

  function toggleSeat(label) {
    setSelected(current => current.includes(label)
      ? current.filter(seat => seat !== label)
      : [...current, label]);
  }

  async function reserveSeats() {
    setLoading(true);
    setMessage('');

    try {
      const result = await api(`/movies/${movie.id}/reservations`, {
        method: 'POST',
        body: JSON.stringify({
          seatIds: selected,
          idempotencyKey: crypto.randomUUID()
        })
      });

      setBooking({
        ...result,
        movie_id: movie.id,
        title: movie.title,
        amount: selected.length * PRICE_CENTS,
        booking_reference: null
      });
      setPage('booking');
      setSelected([]);
      refreshSeats(movie.id).catch(() => {});
    } catch (error) {
      setMessage(error.message);
      refreshSeats(movie.id).catch(() => {});
    } finally {
      setLoading(false);
    }
  }

  async function payForBooking() {
    setPaying(true);
    setMessage('');

    try {
      const result = await api(`/reservations/${booking.id}/pay`, {
        method: 'POST',
        body: '{}'
      });
      setBooking({ ...booking, status: 'CONFIRMED', booking_reference: result.reference });
      await refreshSeats(booking.movie_id);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setPaying(false);
    }
  }

  async function loadBookings() {
    try {
      setBookings(await api('/my/reservations'));
      setPage('history');
      setMessage('');
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function addMovie(event) {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const title = new FormData(form).get('title');
      await api('/movies', { method: 'POST', body: JSON.stringify({ title }) });
      form.reset();
      await refreshMovies();
      setMessage('Movie added.');
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function signOut() {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
    setBooking(null);
    setPage('movies');
  }

  function showMovies() {
    setPage('movies');
    setMovie(null);
    setMessage('');
  }

  if (!user) {
    return (
      <AuthScreen
        mode={mode}
        setMode={setMode}
        onSubmit={submitAuth}
        message={message}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={showMovies}>CineLock</button>
        <nav>
          <button className={page === 'movies' ? 'active' : ''} onClick={showMovies}>Movies</button>
          <button className={page === 'history' ? 'active' : ''} onClick={loadBookings}>My bookings</button>
          {user.role === 'ADMIN' && (
            <button className={page === 'admin' ? 'active' : ''} onClick={() => setPage('admin')}>
              Admin
            </button>
          )}
        </nav>
        <div className="account">
          <span>{user.name}</span>
          <button className="link-button" onClick={signOut}>Log out</button>
        </div>
      </header>

      <main className="page">
        {message && (
          <div className="message" role="status">
            {message}
            <button aria-label="Dismiss message" onClick={() => setMessage('')}>×</button>
          </div>
        )}

        {page === 'movies' && !movie && (
          <section>
            <div className="page-heading">
              <div>
                <p className="eyebrow">CINELOCK</p>
                <h1>Movies</h1>
                <p className="muted">Choose a movie to see available seats.</p>
              </div>
              <span className="muted">{movies.length} available</span>
            </div>

            {movies.length === 0 ? (
              <p className="empty-state">No movies have been added yet.</p>
            ) : (
              <div className="movie-list">
                {movies.map(item => (
                  <button className="movie-card" key={item.id} onClick={() => openMovie(item)}>
                    <span>{item.title}</span>
                    <small>{item.available_count} seats available</small>
                    <span aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {page === 'movies' && movie && (
          <section>
            <button className="link-button back-button" onClick={showMovies}>← Movies</button>
            <div className="page-heading">
              <div>
                <p className="eyebrow">SELECT SEATS</p>
                <h1>{movie.title}</h1>
                <p className="muted">$12 per ticket</p>
              </div>
              <div className="screen-label">SCREEN</div>
            </div>

            <div className="panel seat-panel">
              <SeatGrid seats={seats} selected={selected} onToggle={toggleSeat} />
              <StatusLegend />
            </div>

            <div className="booking-bar">
              <div>
                <small>Selected: {selected.join(', ') || 'none'}</small>
                <strong>{selected.length} {selected.length === 1 ? 'ticket' : 'tickets'}</strong>
              </div>
              <div className="booking-total">
                <strong>${(total / 100).toFixed(2)}</strong>
                <button
                  className="button primary"
                  disabled={selected.length === 0 || loading}
                  onClick={reserveSeats}
                >
                  {loading ? 'Reserving…' : 'Reserve'}
                </button>
              </div>
            </div>
          </section>
        )}

        {page === 'booking' && booking && (
          <section className="narrow-page">
            <p className="eyebrow">{booking.status === 'CONFIRMED' ? 'CONFIRMED' : 'ON HOLD'}</p>
            <h1>{booking.title}</h1>
            <div className="panel booking-summary">
              <p><span>Seats</span><strong>{booking.seats.join(', ')}</strong></p>
              <p><span>Total</span><strong>${(booking.amount / 100).toFixed(2)}</strong></p>
              {booking.status === 'ACTIVE' && (
                <p><span>Time remaining</span><strong>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</strong></p>
              )}
            </div>

            {booking.status === 'CONFIRMED' ? (
              <p className="success-note">Booking reference: <strong>{booking.booking_reference}</strong></p>
            ) : (
              <button
                className="button primary"
                disabled={paying || secondsLeft === 0}
                onClick={payForBooking}
              >
                {paying ? 'Paying…' : secondsLeft === 0 ? 'Hold expired' : 'Pay now'}
              </button>
            )}
            <button className="link-button" onClick={showMovies}>Back to movies</button>
          </section>
        )}

        {page === 'history' && (
          <section>
            <div className="page-heading">
              <div><p className="eyebrow">ACCOUNT</p><h1>My bookings</h1></div>
            </div>
            {bookings.length === 0 ? (
              <p className="empty-state">Your bookings will appear here.</p>
            ) : (
              <div className="booking-list">
                {bookings.map(item => (
                  <article className="booking-row" key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.seats.join(', ')} · ${(item.amount / 100).toFixed(2)}</small>
                    </div>
                    <span className={`status ${item.status.toLowerCase()}`}>{item.status}</span>
                    {item.status === 'ACTIVE' && (
                      <button className="link-button" onClick={() => { setBooking(item); setPage('booking'); }}>
                        Continue
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {page === 'admin' && user.role === 'ADMIN' && (
          <section className="narrow-page">
            <p className="eyebrow">ADMIN</p>
            <h1>Add a movie</h1>
            <form className="panel form" onSubmit={addMovie}>
              <label>Movie title<input name="title" maxLength={200} required /></label>
              <p className="muted">A 10 × 10 seat map is created automatically.</p>
              <button className="button primary">Add movie</button>
            </form>
            <h2 className="subheading">Movies</h2>
            <div className="booking-list">
              {movies.map(item => (
                <div className="booking-row" key={item.id}>
                  <strong>{item.title}</strong>
                  <small>100 seats</small>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
