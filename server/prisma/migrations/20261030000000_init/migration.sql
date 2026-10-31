CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'USER' CHECK(role IN ('ADMIN','USER')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS movies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seats (
 id smallint PRIMARY KEY, row_label char(1) NOT NULL CHECK(row_label BETWEEN 'A' AND 'J'), seat_number smallint NOT NULL CHECK(seat_number BETWEEN 1 AND 10), UNIQUE(row_label,seat_number)
);
INSERT INTO seats(id,row_label,seat_number) SELECT ((ascii(r)-65)*10+n)::smallint, r, n FROM generate_series(0,9) x CROSS JOIN generate_series(1,10) n CROSS JOIN LATERAL (SELECT chr(65+x)::char(1) r) q ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS show_seats (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movie_id uuid NOT NULL REFERENCES movies(id), seat_id smallint NOT NULL REFERENCES seats(id),
 status text NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','HELD','BOOKED')), hold_id uuid,
 UNIQUE(movie_id,seat_id), CHECK((status='HELD' AND hold_id IS NOT NULL) OR (status<>'HELD' AND hold_id IS NULL))
);
CREATE TABLE IF NOT EXISTS reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), movie_id uuid NOT NULL REFERENCES movies(id),
 status text NOT NULL CHECK(status IN ('ACTIVE','CONFIRMED','EXPIRED')), expires_at timestamptz NOT NULL, idempotency_key text NOT NULL,
 booking_reference text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
 UNIQUE(user_id,idempotency_key)
);
ALTER TABLE show_seats DROP CONSTRAINT IF EXISTS show_seats_hold_fk;
ALTER TABLE show_seats ADD CONSTRAINT show_seats_hold_fk FOREIGN KEY(hold_id) REFERENCES reservations(id);
CREATE TABLE IF NOT EXISTS reservation_seats (
 reservation_id uuid NOT NULL REFERENCES reservations(id), show_seat_id uuid NOT NULL REFERENCES show_seats(id), seat_price integer NOT NULL DEFAULT 1200,
 PRIMARY KEY(reservation_id,show_seat_id), UNIQUE(show_seat_id)
);
CREATE TABLE IF NOT EXISTS payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid NOT NULL UNIQUE REFERENCES reservations(id), status text NOT NULL CHECK(status='SUCCEEDED'),
 amount integer NOT NULL, payment_reference text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS show_seats_movie_status_idx ON show_seats(movie_id,status);
CREATE INDEX IF NOT EXISTS reservations_user_idx ON reservations(user_id,created_at DESC);
