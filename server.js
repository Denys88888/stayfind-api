const express = require('express');
const cors = require('cors');
const StellarSdk = require('stellar-sdk');

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

// ── In-memory bookings store ────────────────────────────────────────────────
// NOTE: in-memory only — survives cold starts within the same process but is
// wiped on redeploy/restart. Good enough to stop losing bookings on the
// client's localStorage clear / device switch; a real DB is the next step.
const bookings = [];

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function findConflict({ hotelId, roomType, checkIn, checkOut }, excludeId) {
  const inStart = new Date(checkIn).getTime();
  const inEnd = new Date(checkOut).getTime();
  return bookings.find((b) =>
    b.id !== excludeId &&
    b.hotelId === hotelId &&
    b.roomType === roomType &&
    b.status !== 'cancelled' &&
    datesOverlap(inStart, inEnd, new Date(b.checkIn).getTime(), new Date(b.checkOut).getTime())
  );
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
app.get('/api/bookings/availability', (req, res) => {
  const { hotelId, roomType, checkIn, checkOut } = req.query;
  if (!hotelId || !roomType || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'hotelId, roomType, checkIn, checkOut required' });
  }
  const conflict = findConflict({ hotelId, roomType, checkIn, checkOut });
  res.json({ available: !conflict });
});

// ── Bookings: create ─────────────────────────────────────────────────────────
app.post('/api/bookings', (req, res) => {
  const b = req.body || {};
  const required = ['id', 'piUid', 'hotelId', 'roomType', 'checkIn', 'checkOut'];
  const missing = required.filter((k) => !b[k]);
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });

  const conflict = findConflict(b);
  if (conflict) {
    return res.status(409).json({ error: 'Room already booked for these dates', conflictId: conflict.id });
  }

  const booking = { ...b, status: b.status || 'confirmed', createdAt: new Date().toISOString() };
  bookings.unshift(booking);
  res.json(booking);
});

// ── Bookings: list by user ───────────────────────────────────────────────────
app.get('/api/bookings/:piUid', (req, res) => {
  const { piUid } = req.params;
  res.json(bookings.filter((b) => b.piUid === piUid));
});

// ── Refunds: App-to-User Pi payment ─────────────────────────────────────────
// Per Pi Platform docs, A2U payments are created via the Platform API (server
// key) then signed and submitted to the Pi blockchain (a Stellar fork) using
// the app wallet's own private seed, then marked complete via the Platform API.
//
// Without PI_SERVER_API_KEY / PI_WALLET_PRIVATE_SEED configured, refunds are
// recorded as 'pending_manual' instead of silently failing or (worse) faking
// success — an admin must process them by hand until the seed is set.
async function issueRefund(booking) {
  if (!PI_SERVER_API_KEY || !PI_WALLET_PRIVATE_SEED) {
    booking.refundStatus = 'pending_manual';
    booking.refundNote = 'PI_SERVER_API_KEY / PI_WALLET_PRIVATE_SEED not configured — refund must be sent manually';
    console.warn(`[Refund] ${booking.id}: manual refund required (${booking.totalPi} π to uid ${booking.piUid})`);
    return;
  }

  try {
    // 1) Create the A2U payment record via the Platform API
    const createRes = await fetch('https://api.minepi.com/v2/payments', {
      method: 'POST',
      headers: {
        Authorization: `Key ${PI_SERVER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment: {
          amount: booking.totalPi,
          memo: `StayFind refund: ${booking.id}`,
          metadata: { bookingId: booking.id, reason: 'cancellation' },
          uid: booking.piUid,
        },
      }),
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
      headers: {
        Authorization: `Key ${PI_SERVER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txid }),
    });
    if (!completeRes.ok) throw new Error(`complete failed: ${await completeRes.text()}`);

    booking.refundStatus = 'completed';
    booking.refundTxid = txid;
    booking.refundedAt = new Date().toISOString();
    console.log(`[Refund] ${booking.id}: sent ${booking.totalPi} π, txid ${txid}`);
  } catch (err) {
    booking.refundStatus = 'failed';
    booking.refundNote = String(err);
    console.error(`[Refund] ${booking.id}: failed —`, err);
  }
}

// ── Bookings: cancel ──────────────────────────────────────────────────────────
app.post('/api/bookings/:id/cancel', (req, res) => {
  const { id } = req.params;
  const { piUid } = req.body || {};
  const booking = bookings.find((b) => b.id === id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (piUid && booking.piUid !== piUid) return res.status(403).json({ error: 'Forbidden' });

  const alreadyCancelled = booking.status === 'cancelled';
  booking.status = 'cancelled';
  booking.cancelledAt = new Date().toISOString();

  // Only refund real Pi payments (skip demo/mock txids) and only once.
  const isRealPayment = booking.txid && !String(booking.txid).startsWith('demo_');
  if (!alreadyCancelled && isRealPayment && booking.totalPi && !booking.refundStatus) {
    booking.refundStatus = 'processing';
    issueRefund(booking); // fire-and-forget — cancellation itself must not block on this
  }

  res.json(booking);
});

// ── Admin: refunds needing manual processing ────────────────────────────────
app.get('/api/admin/refunds', requireAdmin, (_req, res) => {
  res.json(bookings.filter((b) => b.refundStatus === 'pending_manual' || b.refundStatus === 'failed'));
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
    corsOrigins: [
      'https://stayfind-pi-booking.onrender.com',
      'http://localhost:5173',
      'http://localhost:5174',
    ],
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
  });
});

// ── User-submitted listings (in-memory) ─────────────────────────────────────
// Any Pi user can submit a property. New listings start 'pending' and only
// show up publicly once an admin approves them via /api/admin/listings —
// unmoderated public listings on a payments-enabled site is a spam/abuse risk.
const listings = [];

app.post('/api/listings', (req, res) => {
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
  listings.unshift(listing);
  res.json(listing);
});

// Public: only approved listings
app.get('/api/listings', (_req, res) => {
  res.json(listings.filter((l) => l.status === 'approved'));
});

app.get('/api/listings/owner/:piUid', (req, res) => {
  res.json(listings.filter((l) => l.ownerUid === req.params.piUid));
});

app.get('/api/listings/:id', (req, res) => {
  const listing = listings.find((l) => String(l.id) === req.params.id && l.status === 'approved');
  if (!listing) return res.status(404).json({ error: 'Not found' });
  res.json(listing);
});

// Admin: moderation queue
app.get('/api/admin/listings', requireAdmin, (req, res) => {
  const { status } = req.query;
  res.json(status ? listings.filter((l) => l.status === status) : listings);
});

app.post('/api/admin/listings/:id/approve', requireAdmin, (req, res) => {
  const listing = listings.find((l) => String(l.id) === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  listing.status = 'approved';
  res.json(listing);
});

app.post('/api/admin/listings/:id/reject', requireAdmin, (req, res) => {
  const listing = listings.find((l) => String(l.id) === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  listing.status = 'rejected';
  listing.rejectReason = req.body?.reason;
  res.json(listing);
});

app.listen(PORT, () => {
  console.log(`StayFind API listening on port ${PORT}`);
  if (!PI_SERVER_API_KEY) {
    console.warn('PI_SERVER_API_KEY not set — running in mock mode');
  }
  console.log(`Admin key: ${ADMIN_KEY === 'stayfind-admin-dev' ? 'DEFAULT (set ADMIN_KEY env var!)' : 'CUSTOM'}`);
});

// ── Keep-alive: free-tier Render sleeps after idle; a cold start during
//    payment approval breaks the Pi flow ("developer failed to approve").
//    Self-ping every 10 min keeps the service warm.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://stayfind-api.onrender.com';
setInterval(() => {
  fetch(`${SELF_URL}/health`).catch(() => {});
}, 10 * 60 * 1000);
