/**
 * Storage layer for bookings and listings.
 *
 * With DATABASE_URL set: backed by Postgres — data survives redeploys and
 * cold restarts, which in-memory arrays cannot.
 * Without it: falls back to the original in-memory arrays (today's
 * behavior). Same interface either way, so server.js doesn't care which
 * one is active. This mirrors the PI_SERVER_API_KEY optional-config
 * pattern already used for payments (mock mode when absent).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const isEnabled = !!DATABASE_URL;

let pool = null;
if (isEnabled) {
  const { Pool } = require('pg');
  // Local/dev Postgres instances typically don't speak SSL; managed hosts
  // (Render, etc.) require it. A localhost connection string is a reliable
  // enough signal to tell the two apart.
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
}

async function init() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      pi_uid TEXT NOT NULL,
      hotel_id TEXT NOT NULL,
      room_type TEXT NOT NULL,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_pi_uid ON bookings(pi_uid);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_hotel_room ON bookings(hotel_id, room_type);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      id BIGINT PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_listings_owner ON listings(owner_uid);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE,
      hotel_id TEXT NOT NULL,
      pi_uid TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reviews_hotel_id ON reviews(hotel_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);

  console.log('[Store] Postgres connected, tables ready');
}

/* ------------------------------------------------------------------ */
/*  In-memory fallback                                                */
/* ------------------------------------------------------------------ */
const memBookings = [];
const memListings = [];
const memReviews = [];
const memSettings = {};

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/* ------------------------------------------------------------------ */
/*  Bookings                                                           */
/* ------------------------------------------------------------------ */

async function findBookingConflict({ hotelId, roomType, checkIn, checkOut }, excludeId) {
  const inStart = new Date(checkIn).getTime();
  const inEnd = new Date(checkOut).getTime();

  if (pool) {
    const { rows } = await pool.query(
      `SELECT data FROM bookings WHERE hotel_id = $1 AND room_type = $2 AND status != 'cancelled' AND id != COALESCE($3, '')`,
      [hotelId, roomType, excludeId || null]
    );
    return rows.map((r) => r.data).find((b) =>
      datesOverlap(inStart, inEnd, new Date(b.checkIn).getTime(), new Date(b.checkOut).getTime())
    ) || null;
  }

  return memBookings.find((b) =>
    b.id !== excludeId &&
    b.hotelId === hotelId &&
    b.roomType === roomType &&
    b.status !== 'cancelled' &&
    datesOverlap(inStart, inEnd, new Date(b.checkIn).getTime(), new Date(b.checkOut).getTime())
  ) || null;
}

async function createBooking(booking) {
  if (pool) {
    await pool.query(
      `INSERT INTO bookings (id, pi_uid, hotel_id, room_type, check_in, check_out, status, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [booking.id, booking.piUid, booking.hotelId, booking.roomType, booking.checkIn, booking.checkOut, booking.status, booking]
    );
    return booking;
  }
  memBookings.unshift(booking);
  return booking;
}

async function getBookingsByOwner(piUid) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT data FROM bookings WHERE pi_uid = $1 ORDER BY created_at DESC`,
      [piUid]
    );
    return rows.map((r) => r.data);
  }
  return memBookings.filter((b) => b.piUid === piUid);
}

async function getBookingById(id) {
  if (pool) {
    const { rows } = await pool.query(`SELECT data FROM bookings WHERE id = $1`, [id]);
    return rows[0]?.data || null;
  }
  return memBookings.find((b) => b.id === id) || null;
}

async function getBookingsByHost(hostUid) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT data FROM bookings WHERE data->>'hostUid' = $1 ORDER BY created_at DESC`,
      [hostUid]
    );
    return rows.map((r) => r.data);
  }
  return memBookings.filter((b) => b.hostUid === hostUid);
}

async function getAllBookings() {
  if (pool) {
    const { rows } = await pool.query(`SELECT data FROM bookings ORDER BY created_at DESC`);
    return rows.map((r) => r.data);
  }
  return memBookings;
}

async function getBookingsDueForPayout() {
  const today = new Date().toISOString().slice(0, 10);
  if (pool) {
    const { rows } = await pool.query(
      `SELECT data FROM bookings WHERE status = 'confirmed' AND check_out < $1`,
      [today]
    );
    return rows.map((r) => r.data).filter((b) => b.hostUid && b.hostPayoutStatus === 'held');
  }
  return memBookings.filter(
    (b) => b.status === 'confirmed' && b.hostUid && b.hostPayoutStatus === 'held' && b.checkOut < today
  );
}

async function updateBooking(id, patch) {
  const current = await getBookingById(id);
  if (!current) return null;
  const updated = { ...current, ...patch };

  if (pool) {
    await pool.query(`UPDATE bookings SET status = $2, data = $3 WHERE id = $1`, [id, updated.status, updated]);
    return updated;
  }
  const idx = memBookings.findIndex((b) => b.id === id);
  memBookings[idx] = updated;
  return updated;
}

/* ------------------------------------------------------------------ */
/*  Listings                                                           */
/* ------------------------------------------------------------------ */

async function createListing(listing) {
  if (pool) {
    await pool.query(
      `INSERT INTO listings (id, owner_uid, status, data) VALUES ($1, $2, $3, $4)`,
      [listing.id, listing.ownerUid, listing.status, listing]
    );
    return listing;
  }
  memListings.unshift(listing);
  return listing;
}

async function getApprovedListings() {
  if (pool) {
    const { rows } = await pool.query(`SELECT data FROM listings WHERE status = 'approved' ORDER BY created_at DESC`);
    return rows.map((r) => r.data);
  }
  return memListings.filter((l) => l.status === 'approved');
}

async function getListingsByOwner(piUid) {
  if (pool) {
    const { rows } = await pool.query(`SELECT data FROM listings WHERE owner_uid = $1 ORDER BY created_at DESC`, [piUid]);
    return rows.map((r) => r.data);
  }
  return memListings.filter((l) => l.ownerUid === piUid);
}

async function getListingById(id) {
  if (pool) {
    const { rows } = await pool.query(`SELECT data FROM listings WHERE id = $1`, [id]);
    return rows[0]?.data || null;
  }
  return memListings.find((l) => String(l.id) === String(id)) || null;
}

async function getAllListings(status) {
  if (pool) {
    const { rows } = status
      ? await pool.query(`SELECT data FROM listings WHERE status = $1 ORDER BY created_at DESC`, [status])
      : await pool.query(`SELECT data FROM listings ORDER BY created_at DESC`);
    return rows.map((r) => r.data);
  }
  return status ? memListings.filter((l) => l.status === status) : memListings;
}

async function updateListing(id, patch) {
  const current = await getListingById(id);
  if (!current) return null;
  const updated = { ...current, ...patch };

  if (pool) {
    await pool.query(`UPDATE listings SET status = $2, data = $3 WHERE id = $1`, [id, updated.status, updated]);
    return updated;
  }
  const idx = memListings.findIndex((l) => String(l.id) === String(id));
  memListings[idx] = updated;
  return updated;
}

/* ------------------------------------------------------------------ */
/*  Reviews                                                             */
/* ------------------------------------------------------------------ */

async function createReview(review) {
  if (pool) {
    await pool.query(
      `INSERT INTO reviews (id, booking_id, hotel_id, pi_uid, data) VALUES ($1, $2, $3, $4, $5)`,
      [review.id, review.bookingId, review.hotelId, review.piUid, review]
    );
    return review;
  }
  memReviews.unshift(review);
  return review;
}

async function getReviewByBooking(bookingId) {
  if (pool) {
    const { rows } = await pool.query(`SELECT data FROM reviews WHERE booking_id = $1`, [bookingId]);
    return rows[0]?.data || null;
  }
  return memReviews.find((r) => r.bookingId === bookingId) || null;
}

async function getReviewsByHotel(hotelId) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT data FROM reviews WHERE hotel_id = $1 ORDER BY created_at DESC`,
      [hotelId]
    );
    return rows.map((r) => r.data);
  }
  return memReviews.filter((r) => r.hotelId === hotelId);
}

// Batch rating summary for a list of hotel ids — used by search results so
// listings show a real average rating without an N+1 request per card.
async function getReviewSummaries(hotelIds) {
  let rows;
  if (pool) {
    const result = await pool.query(
      `SELECT hotel_id, data FROM reviews WHERE hotel_id = ANY($1)`,
      [hotelIds.map(String)]
    );
    rows = result.rows.map((r) => r.data);
  } else {
    const idSet = new Set(hotelIds.map(String));
    rows = memReviews.filter((r) => idSet.has(String(r.hotelId)));
  }

  const byHotel = {};
  for (const r of rows) {
    const key = String(r.hotelId);
    if (!byHotel[key]) byHotel[key] = [];
    byHotel[key].push(r.rating);
  }
  const summary = {};
  for (const [hotelId, ratings] of Object.entries(byHotel)) {
    summary[hotelId] = {
      avgRating: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10,
      count: ratings.length,
    };
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/*  Settings (runtime-adjustable, no redeploy needed)                   */
/* ------------------------------------------------------------------ */

async function getSetting(key, defaultValue) {
  if (pool) {
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    return rows[0] ? rows[0].value : defaultValue;
  }
  return key in memSettings ? memSettings[key] : defaultValue;
}

async function setSetting(key, value) {
  if (pool) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    );
    return value;
  }
  memSettings[key] = value;
  return value;
}

module.exports = {
  isEnabled,
  init,
  findBookingConflict,
  createBooking,
  getBookingsByOwner,
  getBookingById,
  getBookingsByHost,
  getAllBookings,
  getBookingsDueForPayout,
  updateBooking,
  createListing,
  getApprovedListings,
  getListingsByOwner,
  getListingById,
  getAllListings,
  updateListing,
  createReview,
  getReviewByBooking,
  getReviewsByHotel,
  getReviewSummaries,
  getSetting,
  setSetting,
};
