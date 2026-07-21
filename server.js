const express = require('express');
const cors = require('cors');
const StellarSdk = require('stellar-sdk');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 4000;
const PI_SERVER_API_KEY = process.env.PI_SERVER_API_KEY;
const PI_WALLET_PRIVATE_SEED = process.env.PI_WALLET_PRIVATE_SEED;
const ADMIN_KEY = process.env.ADMIN_KEY || 'stayfind-admin-dev';

// Pi blockchain Horizon endpoints (per Pi Platform docs — separate from the
// Platform API host). Picked based on the network the A2U payment reports.
const HORIZON_URLS = {
  'Pi Network': 'https://api.mainnet.minepi.com',
  'Pi Testnet': 'https://api.testnet.minepi.com',
};
const NETWORK_PASSPHRASES = {
  'Pi Network': 'Pi Network',
  'Pi Testnet': 'Pi Testnet',
};

app.use(express.json());
app.use(cors({
  origin: [
    'https://stayfind-pi-booking.onrender.com',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
  ],
  allowedHeaders: ['Content-Type', 'x-admin-key'],
}));

// ── In-memory payment log (last 200 records) ───────────────────────────────
const MAX_PAYMENTS = 200;
const payments = [];

function logPayment(entry) {
  payments.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (payments.length > MAX_PAYMENTS) payments.pop();
}

function findPayment(paymentId) {
  return payments.find(p => p.paymentId === paymentId);
}

function updatePayment(paymentId, update) {
  const idx = payments.findIndex(p => p.paymentId === paymentId);
  if (idx !== -1) Object.assign(payments[idx], update);
}

// ── Admin key middleware ───────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ── Public config (no admin key needed — safe, non-sensitive values) ───────
app.get('/api/config', (_req, res) => {
  res.json({ platformCommissionRate: PLATFORM_COMMISSION_RATE });
});

// ── Payments: approve ──────────────────────────────────────────────────────
app.post('/api/payments/approve/:paymentId', async (req, res) => {
  const { paymentId } = req.params;

  if (!PI_SERVER_API_KEY) {
    console.log('[Mock] Approve payment', paymentId);
    logPayment({ paymentId, action: 'approve', status: 'approved', mock: true });
    return res.json({ mock: true });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Key ${PI_SERVER_API_KEY}` },
      }
    );
    const data = await response.json();
    if (!response.ok) {
      logPayment({ paymentId, action: 'approve', status: 'error', error: data });
      return res.status(response.status).json(data);
    }
    logPayment({
      paymentId,
      action: 'approve',
      status: 'approved',
      amount: data.amount,
      mock: false,
    });
    res.json(data);
  } catch (err) {
    console.error('[Approve] Error:', err);
    logPayment({ paymentId, action: 'approve', status: 'error', error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── Payments: complete ─────────────────────────────────────────────────────
app.post('/api/payments/complete/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  const { txid } = req.body;

  if (!PI_SERVER_API_KEY) {
    console.log('[Mock] Complete payment', paymentId, 'txid:', txid);
    const existing = findPayment(paymentId);
    if (existing) {
      updatePayment(paymentId, { status: 'completed', txid, completedAt: new Date().toISOString() });
    } else {
      logPayment({ paymentId, action: 'complete', status: 'completed', txid, mock: true });
    }
    return res.json({ mock: true });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Key ${PI_SERVER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ txid }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      updatePayment(paymentId, { status: 'error', error: data });
      return res.status(response.status).json(data);
    }
    const existing = findPayment(paymentId);
    if (existing) {
      updatePayment(paymentId, { status: 'completed', txid, completedAt: new Date().toISOString() });
    } else {
      logPayment({ paymentId, action: 'complete', status: 'completed', txid, mock: false });
    }
    res.json(data);
  } catch (err) {
    console.error('[Complete] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// ── Bookings: availability check ────────────────────────────────────────────
app.get('/api/bookings/availability', async (req, res) => {
  const { hotelId, roomType, checkIn, checkOut } = req.query;
  if (!hotelId || !roomType || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'hotelId, roomType, checkIn, checkOut required' });
  }
  const conflict = await store.findBookingConflict({ hotelId, roomType, checkIn, checkOut });
  res.json({ available: !conflict });
});

// ── Bookings: real-payment eligibility ──────────────────────────────────────
// Call BEFORE initiating a real Pi payment. The static demo catalog has no
// real host and delivers no real service — a real Pi payment there takes
// money with nothing behind it. Checked pre-payment, not post-payment: once
// the guest has actually paid, it's too late to just reject the booking.
app.get('/api/bookings/real-payment-eligibility', async (req, res) => {
  const { hotelId } = req.query;
  const listing = await store.getListingById(hotelId).catch(() => null);
  if (listing) return res.json({ allowed: true });
  const allowDemoBookings = await store.getSetting('allowDemoBookings', false);
  res.json({
    allowed: !!allowDemoBookings,
    reason: allowDemoBookings ? undefined : 'This property is a demo listing and cannot be booked with a real Pi payment.',
  });
});

// ── Bookings: create ─────────────────────────────────────────────────────────
app.post('/api/bookings', async (req, res) => {
  const b = req.body || {};
  const required = ['id', 'piUid', 'hotelId', 'roomType', 'checkIn', 'checkOut'];
  const missing = required.filter((k) => !b[k]);
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });

  const conflict = await store.findBookingConflict(b);
  if (conflict) {
    return res.status(409).json({ error: 'Room already booked for these dates', conflictId: conflict.id });
  }

  const booking = { ...b, status: b.status || 'confirmed', createdAt: new Date().toISOString() };
  const listing = await store.getListingById(b.hotelId).catch(() => null);

  // Defense-in-depth only: the real gate is GET /api/bookings/real-payment-
  // eligibility, called by the frontend BEFORE the Pi payment is initiated.
  // By the time this endpoint runs, the guest's Pi has already left their
  // wallet — rejecting the booking now would leave them with nothing to
  // show for it. Instead, flag it so an admin notices and can refund/follow
  // up, rather than silently keeping money for a demo hotel with no host.
  const isRealPayment = b.txid && !String(b.txid).startsWith('demo_');
  if (isRealPayment && !listing) {
    const allowDemoBookings = await store.getSetting('allowDemoBookings', false);
    if (!allowDemoBookings) {
      booking.flaggedDemoRealPayment = true;
      console.warn(`[Booking] ${booking.id}: real Pi payment on demo hotel ${b.hotelId} — needs admin review`);
    }
  }

  // Escrow: if this booking is on a user-submitted listing, hold the guest's
  // payment and schedule a payout (minus platform commission) to the host,
  // released once the stay's checkout date passes. Static demo hotels have
  // no real host, so they're skipped — full amount is platform revenue as before.
  if (listing && listing.ownerUid && listing.ownerUid !== b.piUid && b.totalPi) {
    booking.hostUid = listing.ownerUid;
    booking.platformFeeRate = PLATFORM_COMMISSION_RATE;
    booking.platformFeeAmount = Math.round(b.totalPi * PLATFORM_COMMISSION_RATE * 100) / 100;
    booking.hostPayoutAmount = Math.round((b.totalPi - booking.platformFeeAmount) * 100) / 100;
    booking.hostPayoutStatus = 'held';
  }

  await store.createBooking(booking);
  res.json(booking);
});

// ── Bookings: list by user ───────────────────────────────────────────────────
app.get('/api/bookings/:piUid', async (req, res) => {
  const { piUid } = req.params;
  res.json(await store.getBookingsByOwner(piUid));
});

// ── Bookings: earnings on a host's listings ─────────────────────────────────
app.get('/api/bookings/host/:hostUid', async (req, res) => {
  res.json(await store.getBookingsByHost(req.params.hostUid));
});

// ── App-to-User Pi payments (shared by refunds and host payouts) ───────────
// Per Pi Platform docs, A2U payments are created via the Platform API (server
// key) then signed and submitted to the Pi blockchain (a Stellar fork) using
// the app wallet's own private seed, then marked complete via the Platform API.
async function sendA2UPayment({ uid, amount, memo, metadata }) {
  if (!PI_SERVER_API_KEY || !PI_WALLET_PRIVATE_SEED) {
    throw new Error('PI_SERVER_API_KEY / PI_WALLET_PRIVATE_SEED not configured — payment must be sent manually');
  }

  // 1) Create the A2U payment record via the Platform API
  const createRes = await fetch('https://api.minepi.com/v2/payments', {
    method: 'POST',
    headers: { Authorization: `Key ${PI_SERVER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment: { amount, memo, metadata, uid } }),
  });
  const payment = await createRes.json();
  if (!createRes.ok) throw new Error(`create payment failed: ${JSON.stringify(payment)}`);

  const network = payment.network || 'Pi Testnet';
  const horizonUrl = HORIZON_URLS[network];
  const passphrase = NETWORK_PASSPHRASES[network];
  if (!horizonUrl) throw new Error(`unknown network: ${network}`);

  // 2) Sign and submit the Stellar-protocol transaction from the app wallet
  const server = new StellarSdk.Server(horizonUrl);
  const appKeypair = StellarSdk.Keypair.fromSecret(PI_WALLET_PRIVATE_SEED);
  const account = await server.loadAccount(appKeypair.publicKey());

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: await server.fetchBaseFee().catch(() => '100000'),
    networkPassphrase: passphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: payment.recipient,
        asset: StellarSdk.Asset.native(),
        amount: String(payment.amount),
      })
    )
    .addMemo(StellarSdk.Memo.text(payment.identifier))
    .setTimeout(180)
    .build();

  tx.sign(appKeypair);
  const submitResult = await server.submitTransaction(tx);
  const txid = submitResult.hash;

  // 3) Mark the payment complete via the Platform API
  const completeRes = await fetch(`https://api.minepi.com/v2/payments/${payment.identifier}/complete`, {
    method: 'POST',
    headers: { Authorization: `Key ${PI_SERVER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ txid }),
  });
  if (!completeRes.ok) throw new Error(`complete failed: ${await completeRes.text()}`);

  return txid;
}

// Without PI_SERVER_API_KEY / PI_WALLET_PRIVATE_SEED configured, refunds are
// recorded as 'pending_manual' instead of silently failing or (worse) faking
// success — an admin must process them by hand until the seed is set.
async function issueRefund(booking) {
  try {
    const txid = await sendA2UPayment({
      uid: booking.piUid,
      amount: booking.totalPi,
      memo: `StayFind refund: ${booking.id}`,
      metadata: { bookingId: booking.id, reason: 'cancellation' },
    });
    await store.updateBooking(booking.id, {
      refundStatus: 'completed',
      refundTxid: txid,
      refundedAt: new Date().toISOString(),
    });
    console.log(`[Refund] ${booking.id}: sent ${booking.totalPi} π, txid ${txid}`);
  } catch (err) {
    const status = /not configured/.test(String(err)) ? 'pending_manual' : 'failed';
    await store.updateBooking(booking.id, { refundStatus: status, refundNote: String(err) });
    if (status === 'pending_manual') {
      console.warn(`[Refund] ${booking.id}: manual refund required (${booking.totalPi} π to uid ${booking.piUid})`);
    } else {
      console.error(`[Refund] ${booking.id}: failed —`, err);
    }
  }
}

// ── Host payouts: escrow release ────────────────────────────────────────────
// The platform holds guest payment in its own wallet until the stay's
// checkout date passes (escrow), then pays the host their share minus the
// platform commission. Only applies to bookings on user-submitted listings —
// the static demo catalog has no real host to pay.
const PLATFORM_COMMISSION_RATE = Number(process.env.PLATFORM_COMMISSION_RATE || '0.08');

async function issueHostPayout(booking) {
  try {
    const txid = await sendA2UPayment({
      uid: booking.hostUid,
      amount: booking.hostPayoutAmount,
      memo: `StayFind payout: ${booking.id}`,
      metadata: { bookingId: booking.id, reason: 'host_payout' },
    });
    await store.updateBooking(booking.id, {
      hostPayoutStatus: 'completed',
      hostPayoutTxid: txid,
      hostPayoutAt: new Date().toISOString(),
    });
    console.log(`[Payout] ${booking.id}: sent ${booking.hostPayoutAmount} π to host ${booking.hostUid}, txid ${txid}`);
  } catch (err) {
    const status = /not configured/.test(String(err)) ? 'pending_manual' : 'failed';
    await store.updateBooking(booking.id, { hostPayoutStatus: status, hostPayoutNote: String(err) });
    if (status === 'pending_manual') {
      console.warn(`[Payout] ${booking.id}: manual payout required (${booking.hostPayoutAmount} π to uid ${booking.hostUid})`);
    } else {
      console.error(`[Payout] ${booking.id}: failed —`, err);
    }
  }
}

// Scan for bookings whose stay has ended and release the held escrow.
async function releaseDuePayouts() {
  const due = await store.getBookingsDueForPayout();
  for (const booking of due) {
    await store.updateBooking(booking.id, { hostPayoutStatus: 'processing' });
    await issueHostPayout(booking);
  }
  if (due.length) console.log(`[Payout] released ${due.length} escrow payout(s)`);
}

// ── Bookings: cancel ──────────────────────────────────────────────────────────
app.post('/api/bookings/:id/cancel', async (req, res) => {
  const { id } = req.params;
  const { piUid } = req.body || {};
  const existing = await store.getBookingById(id);
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  if (piUid && existing.piUid !== piUid) return res.status(403).json({ error: 'Forbidden' });

  const alreadyCancelled = existing.status === 'cancelled';
  const isRealPayment = existing.txid && !String(existing.txid).startsWith('demo_');
  const shouldRefund = !alreadyCancelled && isRealPayment && existing.totalPi && !existing.refundStatus;
  // If a host payout was held in escrow and hasn't gone out yet, cancelling
  // the booking cancels the payout too — the guest is getting refunded instead.
  const shouldCancelPayout = !alreadyCancelled && existing.hostUid && existing.hostPayoutStatus === 'held';

  const booking = await store.updateBooking(id, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    ...(shouldRefund ? { refundStatus: 'processing' } : {}),
    ...(shouldCancelPayout ? { hostPayoutStatus: 'cancelled' } : {}),
  });

  // Only refund real Pi payments (skip demo/mock txids) and only once.
  if (shouldRefund) {
    issueRefund(booking); // fire-and-forget — cancellation itself must not block on this
  }

  res.json(booking);
});

// ── Admin: refunds / payouts needing manual processing ─────────────────────
app.get('/api/admin/refunds', requireAdmin, async (_req, res) => {
  const all = await store.getAllBookings();
  res.json(all.filter((b) => b.refundStatus === 'pending_manual' || b.refundStatus === 'failed'));
});

app.get('/api/admin/payouts', requireAdmin, async (_req, res) => {
  const all = await store.getAllBookings();
  res.json(all.filter((b) => b.hostUid));
});

app.get('/api/admin/flagged-bookings', requireAdmin, async (_req, res) => {
  const all = await store.getAllBookings();
  res.json(all.filter((b) => b.flaggedDemoRealPayment));
});

app.post('/api/admin/bookings/:id/release-payout', requireAdmin, async (req, res) => {
  const booking = await store.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.hostUid) return res.status(400).json({ error: 'Booking has no host payout' });
  if (booking.hostPayoutStatus === 'completed') return res.status(400).json({ error: 'Already paid out' });

  await store.updateBooking(booking.id, { hostPayoutStatus: 'processing' });
  await issueHostPayout(booking);
  res.json(await store.getBookingById(booking.id));
});

// ── Admin: stats ───────────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todayPayments = payments.filter(p => p.timestamp.startsWith(today));
  const completed = payments.filter(p => p.status === 'completed');
  const approved = payments.filter(p => p.status === 'approved');
  const errors = payments.filter(p => p.status === 'error');

  res.json({
    mode: PI_SERVER_API_KEY ? 'REAL' : 'MOCK',
    sandbox: !PI_SERVER_API_KEY,
    storage: store.isEnabled ? 'POSTGRES' : 'IN_MEMORY',
    uptime: Math.floor(process.uptime()),
    total: payments.length,
    todayTotal: todayPayments.length,
    completed: completed.length,
    pending: approved.length,
    errors: errors.length,
  });
});

// ── Admin: payments list ───────────────────────────────────────────────────
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const { status, limit = 50 } = req.query;
  let result = payments;
  if (status) result = result.filter(p => p.status === status);
  res.json(result.slice(0, Number(limit)));
});

// ── Admin: manual approve ──────────────────────────────────────────────────
app.post('/api/admin/payments/:paymentId/approve', requireAdmin, async (req, res) => {
  const { paymentId } = req.params;

  if (!PI_SERVER_API_KEY) {
    logPayment({ paymentId, action: 'manual-approve', status: 'approved', mock: true, manual: true });
    return res.json({ mock: true, manual: true });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      { method: 'POST', headers: { Authorization: `Key ${PI_SERVER_API_KEY}` } }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    updatePayment(paymentId, { status: 'approved', manual: true });
    res.json({ ...data, manual: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Admin: manual complete ─────────────────────────────────────────────────
app.post('/api/admin/payments/:paymentId/complete', requireAdmin, async (req, res) => {
  const { paymentId } = req.params;
  const { txid } = req.body;
  if (!txid) return res.status(400).json({ error: 'txid required' });

  if (!PI_SERVER_API_KEY) {
    updatePayment(paymentId, { status: 'completed', txid, manual: true, completedAt: new Date().toISOString() });
    return res.json({ mock: true, manual: true });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Key ${PI_SERVER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ txid }),
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    updatePayment(paymentId, { status: 'completed', txid, manual: true, completedAt: new Date().toISOString() });
    res.json({ ...data, manual: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Admin: cancel payment ──────────────────────────────────────────────────
app.post('/api/admin/payments/:paymentId/cancel', requireAdmin, async (req, res) => {
  const { paymentId } = req.params;

  if (!PI_SERVER_API_KEY) {
    updatePayment(paymentId, { status: 'cancelled', manual: true });
    return res.json({ mock: true, cancelled: true });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/cancel`,
      { method: 'POST', headers: { Authorization: `Key ${PI_SERVER_API_KEY}` } }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    updatePayment(paymentId, { status: 'cancelled', manual: true });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Admin: config ──────────────────────────────────────────────────────────
app.get('/api/admin/config', requireAdmin, (_req, res) => {
  res.json({
    mode: PI_SERVER_API_KEY ? 'REAL' : 'MOCK',
    piApiBase: 'https://api.minepi.com',
    platformCommissionRate: PLATFORM_COMMISSION_RATE,
    corsOrigins: [
      'https://stayfind-pi-booking.onrender.com',
      'http://localhost:5173',
      'http://localhost:5174',
    ],
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
  });
});

// ── Admin: runtime settings (no redeploy needed) ────────────────────────────
app.get('/api/admin/settings', requireAdmin, async (_req, res) => {
  res.json({
    allowDemoBookings: await store.getSetting('allowDemoBookings', false),
  });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  const { allowDemoBookings } = req.body || {};
  if (typeof allowDemoBookings === 'boolean') {
    await store.setSetting('allowDemoBookings', allowDemoBookings);
  }
  res.json({
    allowDemoBookings: await store.getSetting('allowDemoBookings', false),
  });
});

// ── User-submitted listings ──────────────────────────────────────────────────
// Any Pi user can submit a property. New listings start 'pending' and only
// show up publicly once an admin approves them via /api/admin/listings —
// unmoderated public listings on a payments-enabled site is a spam/abuse risk.

app.post('/api/listings', async (req, res) => {
  const l = req.body || {};
  const required = ['ownerUid', 'name', 'location', 'address', 'price', 'description'];
  const missing = required.filter((k) => !l[k]);
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });

  const listing = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    ownerUid: l.ownerUid,
    name: String(l.name),
    location: String(l.location),
    address: String(l.address),
    price: Number(l.price),
    description: String(l.description),
    images: Array.isArray(l.images) && l.images.length ? l.images.slice(0, 8) : ['/hotel-1.jpg'],
    amenities: Array.isArray(l.amenities) ? l.amenities : [],
    propertyType: l.propertyType || 'Hotel',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await store.createListing(listing);
  res.json(listing);
});

// Public: only approved listings
app.get('/api/listings', async (_req, res) => {
  res.json(await store.getApprovedListings());
});

app.get('/api/listings/owner/:piUid', async (req, res) => {
  res.json(await store.getListingsByOwner(req.params.piUid));
});

app.get('/api/listings/:id', async (req, res) => {
  const listing = await store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved') return res.status(404).json({ error: 'Not found' });
  res.json(listing);
});

// ── Reviews ──────────────────────────────────────────────────────────────────
// A review can only be left once per booking, only by the guest who made it,
// and only after the stay's checkout date has passed — no reviewing a stay
// that hasn't happened yet, and no one but the actual guest can post one.
app.get('/api/reviews/:hotelId', async (req, res) => {
  res.json(await store.getReviewsByHotel(req.params.hotelId));
});

app.post('/api/reviews', async (req, res) => {
  const { bookingId, piUid, rating, text, authorName } = req.body || {};
  if (!bookingId || !piUid || !rating || !text) {
    return res.status(400).json({ error: 'bookingId, piUid, rating, text required' });
  }
  const ratingNum = Number(rating);
  if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'rating must be between 1 and 5' });
  }

  const booking = await store.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.piUid !== piUid) return res.status(403).json({ error: 'Forbidden' });
  if (booking.status === 'cancelled') return res.status(400).json({ error: 'Cannot review a cancelled booking' });
  if (new Date(booking.checkOut) > new Date()) {
    return res.status(400).json({ error: 'Cannot review a stay that has not ended yet' });
  }

  const existing = await store.getReviewByBooking(bookingId);
  if (existing) return res.status(409).json({ error: 'Already reviewed' });

  const review = {
    id: `RV-${Date.now()}${Math.floor(Math.random() * 1000)}`,
    bookingId,
    hotelId: booking.hotelId,
    piUid,
    authorName: String(authorName || 'Pi traveler').slice(0, 60),
    rating: ratingNum,
    text: String(text).slice(0, 2000),
    createdAt: new Date().toISOString(),
  };
  await store.createReview(review);
  res.json(review);
});

// Admin: moderation queue
app.get('/api/admin/listings', requireAdmin, async (req, res) => {
  const { status } = req.query;
  res.json(await store.getAllListings(status));
});

app.post('/api/admin/listings/:id/approve', requireAdmin, async (req, res) => {
  const listing = await store.updateListing(req.params.id, { status: 'approved' });
  if (!listing) return res.status(404).json({ error: 'Not found' });
  res.json(listing);
});

app.post('/api/admin/listings/:id/reject', requireAdmin, async (req, res) => {
  const listing = await store.updateListing(req.params.id, { status: 'rejected', rejectReason: req.body?.reason });
  if (!listing) return res.status(404).json({ error: 'Not found' });
  res.json(listing);
});

store.init()
  .then(() => {
    if (!store.isEnabled) {
      console.warn('DATABASE_URL not set — bookings/listings are in-memory and will be lost on redeploy');
    }
  })
  .catch((err) => {
    console.error('[Store] Postgres init failed, falling back to in-memory:', err);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`StayFind API listening on port ${PORT}`);
      if (!PI_SERVER_API_KEY) {
        console.warn('PI_SERVER_API_KEY not set — running in mock mode');
      }
      console.log(`Admin key: ${ADMIN_KEY === 'stayfind-admin-dev' ? 'DEFAULT (set ADMIN_KEY env var!)' : 'CUSTOM'}`);
      console.log(`Platform commission: ${(PLATFORM_COMMISSION_RATE * 100).toFixed(1)}%`);
      releaseDuePayouts().catch((err) => console.error('[Payout] initial scan failed:', err));
    });
  });

// ── Keep-alive: free-tier Render sleeps after idle; a cold start during
//    payment approval breaks the Pi flow ("developer failed to approve").
//    Self-ping every 10 min keeps the service warm.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://stayfind-api.onrender.com';
setInterval(() => {
  fetch(`${SELF_URL}/health`).catch(() => {});
}, 10 * 60 * 1000);

// ── Escrow release: check every 30 min for bookings whose checkout date has
//    passed and release the held payout to the host.
setInterval(() => {
  releaseDuePayouts().catch((err) => console.error('[Payout] scan failed:', err));
}, 30 * 60 * 1000);
