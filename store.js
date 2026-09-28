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

/** True only when Postgres is actually usable — not merely configured. */
function isPersistent() {
  return !!pool;
}

async function init() {
  if (!pool) return;
  try {
    await initSchema();
  } catch (err) {
    // Keeping a half-connected pool is worse than having none: every query
    // would throw, and callers that ask whether storage is durable would be
    // told yes. Drop it so the in-memory fallback is real and isPersistent()
    // tells the truth.
    pool = null;
    throw err;
  }
}

async function initSchema() {
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
  // One Pi payment funds at most one booking. Enforced by the database rather
  // than by a read-then-write check, which two concurrent requests can both
  // pass. Partial so the many bookings without a paymentId aren't constrained.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_payment_id
    ON bookings ((data->>'paymentId')) WHERE data->>'paymentId' IS NOT NULL;
  `);

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

  // Who may use the admin panel. The uid is the authority: it is what Pi's own
  // /v2/me asserts about the caller, and it cannot be handed to anyone else.
  // A username can be reassigned and a shared key can be copied or leaked, so
  // neither belongs here as the grant. The username column exists only so a
  // human can read who holds the seat.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      pi_uid TEXT PRIMARY KEY,
      username TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
const memAdmins = [];

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

/** Raised when a Pi payment has already funded a booking. */
class DuplicatePaymentError extends Error {
  constructor(paymentId) {
    super(`payment ${paymentId} already funded a booking`);
    this.name = 'DuplicatePaymentError';
    this.paymentId = paymentId;
  }
}

async function createBooking(booking) {
  // The caller checks for a duplicate payment first, but awaits a network
  // round-trip to Pi in between — two requests carrying the same paymentId can
  // both pass that check. This is the last, gap-free point to catch it: the
  // unique index does it for Postgres, and the in-memory scan below runs
  // synchronously right before the insert, with no await to interleave on.
  if (booking.paymentId) {
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO bookings (id, pi_uid, hotel_id, room_type, check_in, check_out, status, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [booking.id, booking.piUid, booking.hotelId, booking.roomType, booking.checkIn, booking.checkOut, booking.status, booking]
        );
        return booking;
      } catch (err) {
        if (err.code === '23505' && String(err.constraint || '').includes('payment')) {
          throw new DuplicatePaymentError(booking.paymentId);
        }
        throw err;
      }
    }
    if (memBookings.some((x) => x.paymentId === booking.paymentId)) {
      throw new DuplicatePaymentError(booking.paymentId);
    }
  }

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

// Replay guard: one Pi payment may fund exactly one booking. Without this,
// the same completed payment could be submitted repeatedly to create several
// bookings, each arming its own payout out of the app wallet.
async function getBookingByPaymentId(paymentId) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT data FROM bookings WHERE data->>'paymentId' = $1 LIMIT 1`,
      [paymentId]
    );
    return rows[0]?.data || null;
  }
  return memBookings.find((b) => b.paymentId === paymentId) || null;
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

/**
 * Atomically claim the right to refund a booking.
 *
 * Returns the updated booking if this caller won the claim, or null if a
 * refund was already claimed. A read-then-write in the route can't do this:
 * two concurrent cancellations both read "no refund yet" across the await and
 * both send the guest their money.
 */
async function claimRefund(id) {
  if (pool) {
    const { rows } = await pool.query(
      `UPDATE bookings
          SET data = jsonb_set(data, '{refundStatus}', '"processing"')
        WHERE id = $1 AND data->>'refundStatus' IS NULL
        RETURNING data`,
      [id]
    );
    return rows[0]?.data || null;
  }
  // Single-threaded and await-free: nothing can interleave between the check
  // and the assignment.
  const booking = memBookings.find((x) => x.id === id);
  if (!booking || booking.refundStatus) return null;
  booking.refundStatus = 'processing';
  return booking;
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

async function getAllReviews() {
  if (pool) {
    const { rows } = await pool.query(`SELECT data FROM reviews ORDER BY created_at DESC LIMIT 200`);
    return rows.map((r) => r.data);
  }
  return memReviews.slice(0, 200);
}

async function deleteReview(id) {
  if (pool) {
    const { rowCount } = await pool.query(`DELETE FROM reviews WHERE id = $1`, [id]);
    return rowCount > 0;
  }
  const idx = memReviews.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  memReviews.splice(idx, 1);
  return true;
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

/* ------------------------------------------------------------------ */
/*  Admins (authority is the Pi uid, never a username or a shared key)  */
/* ------------------------------------------------------------------ */

async function isAdminUid(uid) {
  if (!uid) return false;
  if (pool) {
    const { rows } = await pool.query(`SELECT 1 FROM admins WHERE pi_uid = $1`, [uid]);
    return rows.length > 0;
  }
  return memAdmins.some(a => a.piUid === uid);
}

async function countAdmins() {
  if (pool) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM admins`);
    return rows[0].n;
  }
  return memAdmins.length;
}

async function listAdmins() {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT pi_uid, username, added_at FROM admins ORDER BY added_at`
    );
    return rows.map(r => ({ piUid: r.pi_uid, username: r.username, addedAt: r.added_at }));
  }
  return memAdmins.map(a => ({ ...a }));
}

/**
 * Takes the very first admin seat. Returns the new row, or null if a seat was
 * already taken — so the bootstrap can happen exactly once in the lifetime of
 * the database.
 *
 * The emptiness test and the insert run inside one transaction that first
 * takes an exclusive lock. A plain "SELECT, then INSERT if empty" is not
 * enough: under READ COMMITTED neither transaction sees the other's
 * uncommitted row, so two simultaneous claims by different people would both
 * find the table empty and both succeed.
 */
async function claimFirstAdmin(uid, username) {
  if (!uid) throw new Error('claimFirstAdmin requires a uid');
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE admins IN EXCLUSIVE MODE');
      const { rows: taken } = await client.query(`SELECT 1 FROM admins LIMIT 1`);
      if (taken.length > 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const { rows } = await client.query(
        `INSERT INTO admins (pi_uid, username) VALUES ($1, $2)
         RETURNING pi_uid, username, added_at`,
        [uid, username || null]
      );
      await client.query('COMMIT');
      return { piUid: rows[0].pi_uid, username: rows[0].username, addedAt: rows[0].added_at };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  // Single-threaded and no await between the check and the push, so this is
  // already atomic. Do not introduce one.
  if (memAdmins.length > 0) return null;
  const row = { piUid: uid, username: username || null, addedAt: new Date().toISOString() };
  memAdmins.push(row);
  return { ...row };
}

module.exports = {
  isEnabled,
  isPersistent,
  init,
  findBookingConflict,
  createBooking,
  getBookingsByOwner,
  getBookingById,
  getBookingByPaymentId,
  DuplicatePaymentError,
  claimRefund,
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
  getAllReviews,
  deleteReview,
  getSetting,
  setSetting,
  isAdminUid,
  countAdmins,
  listAdmins,
  claimFirstAdmin,
};
