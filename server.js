const express = require('express');
const cors = require('cors');
const StellarSdk = require('stellar-sdk');
const store = require('./store');
const { splitBookingPayment } = require('./money');
const pricing = require('./pricing');

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
  allowedHeaders: ['Content-Type', 'x-admin-key', 'Authorization'],
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

// ── Pi identity verification ────────────────────────────────────────────────
// Resolves a Bearer access token to its Pi uid via the Platform API's /v2/me
// endpoint. Returns the uid, or null if the token is missing/invalid.
// Without this, anyone who knows another user's uid (uids appear elsewhere,
// e.g. as listing ownerUid) could read or modify their data by simply
// putting that uid in a request — the token proves the caller actually is
// that user.
// Verified tokens are cached so a browsing session doesn't hit Pi's API on
// every single request — that would add a round-trip to each call and make
// the whole app unavailable whenever Pi's API is slow or down. Keyed by a
// hash rather than the token itself so raw credentials aren't held in memory.
// Only successful lookups are cached: caching failures would lock a user out
// for the full TTL after one transient network blip.
const PI_UID_CACHE_TTL_MS = 5 * 60 * 1000;
const PI_UID_CACHE_MAX = 1000;
const PI_ME_TIMEOUT_MS = 8000;
const piUidCache = new Map();

function hashToken(token) {
  return require('crypto').createHash('sha256').update(token).digest('hex');
}

async function resolvePiUid(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const key = hashToken(token);
  const cached = piUidCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.uid;
  if (cached) piUidCache.delete(key);

  try {
    const meRes = await fetch('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PI_ME_TIMEOUT_MS),
    });
    if (!meRes.ok) return null;
    const me = await meRes.json();
    if (!me.uid) return null;

    // Map preserves insertion order, so the first key is the oldest entry.
    if (piUidCache.size >= PI_UID_CACHE_MAX) {
      piUidCache.delete(piUidCache.keys().next().value);
    }
    piUidCache.set(key, { uid: me.uid, expiresAt: Date.now() + PI_UID_CACHE_TTL_MS });
    return me.uid;
  } catch (err) {
    console.error('[PiAuth] /v2/me verification failed:', err.message || err);
    return null;
  }
}

// Middleware: verifies the caller's token resolves to the :paramName in the URL.
function requirePiIdentity(paramName) {
  return async (req, res, next) => {
    const uid = await resolvePiUid(req);
    if (!uid) return res.status(401).json({ error: 'Missing or invalid access token' });
    if (uid !== req.params[paramName]) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ── Public config (no admin key needed — safe, non-sensitive values) ───────
// The frontend reads its pricing rates from here rather than hardcoding them,
// so the price a guest is charged always matches what the server expects.
app.get('/api/config', async (_req, res) => {
  res.json({
    platformCommissionRate: await getPlatformCommissionRate(),
    piUsdRate: pricing.PI_USD_RATE,
    taxRate: pricing.TAX_RATE,
  });
});

// ── Health ──────────────────────────────────────────────────────────────────
// Deliberately unauthenticated and deliberately coarse: it answers "is this
// deployment configured to keep people's bookings and to move real Pi?"
// without naming hosts, versions or anything an attacker could act on.
// `persistentStorage: false` means every restart wipes bookings and listings.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    persistentStorage: !!store.isEnabled,
    piPaymentsConfigured: !!PI_SERVER_API_KEY,
    payoutsConfigured: !!PI_WALLET_PRIVATE_SEED,
    uptimeSeconds: Math.floor(process.uptime()),
  });
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
app.post('/api/payments/cancel/:paymentId', async (req, res) => {
  const { paymentId } = req.params;

  if (!PI_SERVER_API_KEY) {
    console.log('[Mock] Cancel payment', paymentId);
    updatePayment(paymentId, { status: 'cancelled' });
    logPayment({ paymentId, action: 'cancel', status: 'cancelled', mock: true });
    return res.json({ mock: true });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Key ${PI_SERVER_API_KEY}` },
      }
    );
    const data = await response.json();
    if (!response.ok) {
      logPayment({ paymentId, action: 'cancel', status: 'error', error: data });
      return res.status(response.status).json(data);
    }
    updatePayment(paymentId, { status: 'cancelled' });
    logPayment({ paymentId, action: 'cancel', status: 'cancelled', mock: false });
    res.json(data);
  } catch (err) {
    console.error('[Cancel] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

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

function datesOverlapRange(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// A host can block their own listing's dates (renovation, booked elsewhere,
// etc). True whenever [checkIn, checkOut) overlaps any blocked range.
function isBlockedByHost(listing, checkIn, checkOut) {
  if (!listing || !Array.isArray(listing.blockedRanges)) return false;
  const inStart = new Date(checkIn).getTime();
  const inEnd = new Date(checkOut).getTime();
  return listing.blockedRanges.some((r) =>
    datesOverlapRange(inStart, inEnd, new Date(r.checkIn).getTime(), new Date(r.checkOut).getTime())
  );
}

// ── Bookings: availability check ────────────────────────────────────────────
app.get('/api/bookings/availability', async (req, res) => {
  const { hotelId, roomType, checkIn, checkOut } = req.query;
  if (!hotelId || !roomType || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'hotelId, roomType, checkIn, checkOut required' });
  }
  const conflict = await store.findBookingConflict({ hotelId, roomType, checkIn, checkOut });
  if (conflict) return res.json({ available: false });

  const listing = await store.getListingById(hotelId).catch(() => null);
  if (isBlockedByHost(listing, checkIn, checkOut)) {
    return res.json({ available: false, reason: 'blocked_by_host' });
  }
  res.json({ available: true });
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

// ── Payment verification ────────────────────────────────────────────────────
// Asks Pi's Platform API what a payment actually was. The booking body is
// client-supplied, so its totalPi is a *claim*, not a fact — and totalPi is
// what later decides how much real Pi leaves the app wallet as a host payout
// or a refund. Taking it on trust would let anyone book with an invented
// amount and drain the wallet. Everything that moves money must come from
// this response, never from the request body.
// Returns { ok, amount, uid, txid } or { ok: false, reason }.
async function verifyPiPayment(paymentId) {
  if (!PI_SERVER_API_KEY) return { ok: false, reason: 'not_configured' };
  try {
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Key ${PI_SERVER_API_KEY}` },
      signal: AbortSignal.timeout(PI_ME_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, reason: `lookup_failed_${r.status}` };
    const p = await r.json();

    const s = p.status || {};
    if (s.cancelled || s.user_cancelled) return { ok: false, reason: 'cancelled' };
    // transaction_verified means the Pi actually moved on-chain. Anything
    // less and the guest has not really paid yet.
    if (!s.transaction_verified) return { ok: false, reason: 'not_verified' };

    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad_amount' };

    return { ok: true, amount, uid: p.user_uid, txid: p.transaction?.txid };
  } catch (err) {
    console.error(`[PayVerify] ${paymentId}:`, err.message || err);
    return { ok: false, reason: 'lookup_error' };
  }
}

// ── Bookings: create ─────────────────────────────────────────────────────────
app.post('/api/bookings', async (req, res) => {
  const b = req.body || {};
  const required = ['id', 'piUid', 'hotelId', 'roomType', 'checkIn', 'checkOut'];
  const missing = required.filter((k) => !b[k]);
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });

  // Only the guest themselves may file their own booking — piUid decides whose
  // booking this is and, on cancellation, who the refund is paid to.
  const callerUid = await resolvePiUid(req);
  if (!callerUid) return res.status(401).json({ error: 'Missing or invalid access token' });
  if (callerUid !== b.piUid) return res.status(403).json({ error: 'Forbidden' });

  const isRealPaymentEarly = b.txid && !String(b.txid).startsWith('demo_');
  const listing = await store.getListingById(b.hotelId).catch(() => null);
  const conflict = await store.findBookingConflict(b);
  const blocked = isBlockedByHost(listing, b.checkIn, b.checkOut);

  // Same principle as the demo-hotel check below: the pre-payment gate is
  // GET /api/bookings/availability, called by the frontend before the Pi
  // payment is initiated. If a conflict/block still slips through (e.g. a
  // race between two guests paying at nearly the same moment, or the host
  // blocking dates after the guest already started paying), rejecting here
  // would leave a guest who already paid with neither a room nor their Pi
  // back. Only hard-reject when no real payment is on the line yet (demo
  // mode) — otherwise flag it for admin follow-up.
  if (conflict || blocked) {
    if (!isRealPaymentEarly) {
      return res.status(409).json({
        error: blocked ? 'These dates are blocked by the host' : 'Room already booked for these dates',
        conflictId: conflict?.id,
      });
    }
    console.warn(`[Booking] ${b.id}: ${blocked ? 'host-blocked dates' : `conflict with ${conflict.id}`} on a real payment — needs admin review`);
  }

  // Establish what was actually paid, from Pi rather than from the request.
  // mockMode: with no server API key nothing here moves real Pi anyway, so
  // local/dev flows keep working without a live payment to verify against.
  const mockMode = !PI_SERVER_API_KEY;
  let verifiedAmount = null;
  let paymentIssue = null;

  if (isRealPaymentEarly && !mockMode) {
    if (!b.paymentId) {
      paymentIssue = 'missing_payment_id';
    } else {
      const duplicate = await store.getBookingByPaymentId(b.paymentId);
      if (duplicate) {
        return res.status(409).json({
          error: 'This payment has already been used for another booking',
          bookingId: duplicate.id,
        });
      }
      const verified = await verifyPiPayment(b.paymentId);
      if (!verified.ok) paymentIssue = `unverified_${verified.reason}`;
      else if (verified.uid !== b.piUid) paymentIssue = 'payment_belongs_to_another_user';
      else verifiedAmount = verified.amount;
    }
    // What was paid is now known; check it against what the stay actually
    // costs. The browser decides the charge, so without this a guest could pay
    // a token amount, hold the dates, and have the host paid that token amount
    // minus commission. Only user-submitted listings have a server-side price
    // to compare against; the static demo catalogue has none.
    if (!paymentIssue && listing) {
      const expectedPi = pricing.expectedTotalPi(listing.price, b.checkIn, b.checkOut);
      if (pricing.isUnderpaid(verifiedAmount, expectedPi)) {
        paymentIssue = `underpaid_${verifiedAmount}_of_${expectedPi}`;
        console.warn(`[Booking] ${b.id}: paid ${verifiedAmount} π but stay costs ${expectedPi} π`);
      }
    }

    if (paymentIssue) {
      console.warn(`[Booking] ${b.id}: payment not verified (${paymentIssue}) — payout withheld`);
    }
  }

  const parsedTotalPi = Number(b.totalPi);
  const claimedTotalPi = Number.isFinite(parsedTotalPi) && parsedTotalPi > 0 ? parsedTotalPi : undefined;

  // Whitelist what a client may set. Spreading the raw body would let a caller
  // hand themselves payout/refund fields (hostPayoutAmount, refundStatus, …)
  // that decide how much Pi leaves the app wallet.
  const booking = {
    id: String(b.id),
    piUid: b.piUid,
    hotelId: b.hotelId,
    hotelName: b.hotelName,
    roomType: b.roomType,
    image: b.image,
    location: b.location,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    nights: b.nights,
    guests: b.guests,
    totalUsd: b.totalUsd,
    // Coerced to a real number here: totalPi feeds the payout/refund maths,
    // and a string or NaN slipping through would throw deep inside those
    // rather than being rejected at the edge.
    totalPi: verifiedAmount ?? claimedTotalPi,
    txid: b.txid,
    paymentId: b.paymentId,
    bookedAt: b.bookedAt,
    status: b.status === 'cancelled' ? 'cancelled' : 'confirmed',
    createdAt: new Date().toISOString(),
    ...(paymentIssue ? { flaggedUnverifiedPayment: paymentIssue } : {}),
    ...(conflict ? { flaggedDoubleBooked: true, conflictBookingId: conflict.id } : {}),
    ...(blocked ? { flaggedHostBlockedDates: true } : {}),
  };

  // Defense-in-depth only: the real gate is GET /api/bookings/real-payment-
  // eligibility, called by the frontend BEFORE the Pi payment is initiated.
  // By the time this endpoint runs, the guest's Pi has already left their
  // wallet — rejecting the booking now would leave them with nothing to
  // show for it. Instead, flag it so an admin notices and can refund/follow
  // up, rather than silently keeping money for a demo hotel with no host.
  if (isRealPaymentEarly && !listing) {
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
  // Only arm a payout against money we know arrived: a payment Pi confirmed as
  // verified (or local mock mode, where nothing is real). A demo txid or an
  // unverifiable payment must never schedule real Pi out of the app wallet.
  const payoutEligible = mockMode || (isRealPaymentEarly && !paymentIssue);

  if (payoutEligible && listing && listing.ownerUid && listing.ownerUid !== b.piUid && booking.totalPi) {
    const commissionRate = await getPlatformCommissionRate();
    const { platformFeeAmount, hostPayoutAmount } = splitBookingPayment(booking.totalPi, commissionRate);
    booking.hostUid = listing.ownerUid;
    booking.platformFeeRate = commissionRate;
    booking.platformFeeAmount = platformFeeAmount;
    booking.hostPayoutAmount = hostPayoutAmount;
    booking.hostPayoutStatus = 'held';
  }

  try {
    await store.createBooking(booking);
  } catch (err) {
    if (err instanceof store.DuplicatePaymentError) {
      return res.status(409).json({ error: 'This payment has already been used for another booking' });
    }
    throw err;
  }
  res.json(booking);
});

// ── Bookings: list by user ───────────────────────────────────────────────────
app.get('/api/bookings/:piUid', requirePiIdentity('piUid'), async (req, res) => {
  const { piUid } = req.params;
  res.json(await store.getBookingsByOwner(piUid));
});

// ── Bookings: earnings on a host's listings ─────────────────────────────────
app.get('/api/bookings/host/:hostUid', requirePiIdentity('hostUid'), async (req, res) => {
  res.json(await store.getBookingsByHost(req.params.hostUid));
});

// ── App-to-User Pi payments (shared by refunds and host payouts) ───────────
// Per Pi Platform docs, A2U payments are created via the Platform API (server
// key) then signed and submitted to the Pi blockchain (a Stellar fork) using
// the app wallet's own private seed, then marked complete via the Platform API.
// Raised when the transfer succeeded on-chain but Pi's Platform API could not
// be told about it. Carries the txid so the booking can record that the money
// really did go out — retrying such a payment would send it a second time.
class A2USentButUnconfirmed extends Error {
  constructor(txid, detail) {
    super(`sent on-chain (txid ${txid}) but Platform API completion failed: ${detail}`);
    this.name = 'A2USentButUnconfirmed';
    this.txid = txid;
  }
}

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
  // The Pi is already on-chain at this point. A failure here means only that
  // Pi's records are out of step — the money HAS left the wallet, so this must
  // never be reported as a plain failure that someone would retry.
  if (!completeRes.ok) throw new A2USentButUnconfirmed(txid, await completeRes.text());

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
    if (err instanceof A2USentButUnconfirmed) {
      await store.updateBooking(booking.id, {
        refundStatus: 'sent_unconfirmed',
        refundTxid: err.txid,
        refundNote: String(err),
      });
      console.error(`[Refund] ${booking.id}: PI ALREADY SENT (txid ${err.txid}) — do not retry`, err);
      return;
    }
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
//
// The rate is runtime-adjustable via the settings store (admin panel, no
// redeploy needed) — the env var is only the default before an admin ever
// sets one explicitly.
const DEFAULT_PLATFORM_COMMISSION_RATE = Number(process.env.PLATFORM_COMMISSION_RATE || '0.08');

async function getPlatformCommissionRate() {
  return await store.getSetting('platformCommissionRate', DEFAULT_PLATFORM_COMMISSION_RATE);
}

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
    if (err instanceof A2USentButUnconfirmed) {
      await store.updateBooking(booking.id, {
        hostPayoutStatus: 'sent_unconfirmed',
        hostPayoutTxid: err.txid,
        hostPayoutNote: String(err),
      });
      console.error(`[Payout] ${booking.id}: PI ALREADY SENT (txid ${err.txid}) — do not retry`, err);
      return;
    }
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
  const callerUid = await resolvePiUid(req);
  if (!callerUid) return res.status(401).json({ error: 'Missing or invalid access token' });
  const existing = await store.getBookingById(id);
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  if (existing.piUid !== callerUid) return res.status(403).json({ error: 'Forbidden' });

  const alreadyCancelled = existing.status === 'cancelled';
  const isRealPayment = existing.txid && !String(existing.txid).startsWith('demo_');

  // The guest's money may have already been forwarded to the host. Refunding
  // on top of that pays the same booking out twice, so those are settled by
  // hand. Only an escrow still sitting untouched ('held') can be called off.
  const payoutAlreadyGone = existing.hostUid && existing.hostPayoutStatus !== 'held';
  const shouldCancelPayout = !alreadyCancelled && existing.hostUid && existing.hostPayoutStatus === 'held';

  // A refund sends real Pi out of the app wallet using the booking's stored
  // totalPi. If that amount was never confirmed against the actual Pi payment,
  // refunding it would pay out money the platform may never have received —
  // an admin settles those by hand instead.
  const refundAllowed =
    !alreadyCancelled &&
    isRealPayment &&
    existing.totalPi &&
    !existing.flaggedUnverifiedPayment &&
    !payoutAlreadyGone;

  if (!alreadyCancelled && isRealPayment && !refundAllowed) {
    const reason = existing.flaggedUnverifiedPayment
      ? `payment was never verified (${existing.flaggedUnverifiedPayment})`
      : payoutAlreadyGone
        ? `host payout is '${existing.hostPayoutStatus}'`
        : 'no refundable amount';
    console.warn(`[Refund] ${id}: withheld — ${reason}`);
  }

  // Claim the refund before anything else: this is what stops two concurrent
  // cancellations from each sending the guest their money.
  const claimed = refundAllowed ? await store.claimRefund(id) : null;

  const booking = await store.updateBooking(id, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    ...(shouldCancelPayout ? { hostPayoutStatus: 'cancelled' } : {}),
    ...(!refundAllowed && !alreadyCancelled && isRealPayment ? { refundNeedsReview: true } : {}),
  });

  if (claimed) {
    issueRefund(booking); // fire-and-forget — cancellation itself must not block on this
  }

  res.json(booking);
});

// ── Admin: refunds / payouts needing manual processing ─────────────────────
app.get('/api/admin/refunds', requireAdmin, async (_req, res) => {
  const all = await store.getAllBookings();
  res.json(all.filter((b) =>
    b.refundStatus === 'pending_manual' ||
    b.refundStatus === 'failed' ||
    // Sent on-chain but Pi's records disagree — needs reconciling, never a retry.
    b.refundStatus === 'sent_unconfirmed' ||
    // Cancelled but not auto-refundable (unverified payment, or the host was
    // already paid) — a human decides what the guest is owed.
    b.refundNeedsReview
  ));
});

app.get('/api/admin/payouts', requireAdmin, async (_req, res) => {
  const all = await store.getAllBookings();
  res.json(all.filter((b) => b.hostUid));
});

app.get('/api/admin/flagged-bookings', requireAdmin, async (_req, res) => {
  const all = await store.getAllBookings();
  res.json(all.filter((b) =>
    b.flaggedDemoRealPayment ||
    b.flaggedDoubleBooked ||
    b.flaggedHostBlockedDates ||
    // Withheld payouts/refunds land here — this queue is the only place they
    // surface for a human to settle, so it must include them.
    b.flaggedUnverifiedPayment
  ));
});

app.post('/api/admin/bookings/:id/release-payout', requireAdmin, async (req, res) => {
  const booking = await store.getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.hostUid) return res.status(400).json({ error: 'Booking has no host payout' });
  // 'sent_unconfirmed' means the Pi already left the wallet on-chain even
  // though Pi's records disagree — releasing again would pay twice.
  // 'processing' means a release is in flight right now.
  const notRetryable = ['completed', 'sent_unconfirmed', 'processing', 'cancelled'];
  if (notRetryable.includes(booking.hostPayoutStatus)) {
    return res.status(400).json({ error: `Payout is '${booking.hostPayoutStatus}' — not retryable` });
  }

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
app.get('/api/admin/config', requireAdmin, async (_req, res) => {
  res.json({
    mode: PI_SERVER_API_KEY ? 'REAL' : 'MOCK',
    piApiBase: 'https://api.minepi.com',
    platformCommissionRate: await getPlatformCommissionRate(),
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
    platformCommissionRate: await getPlatformCommissionRate(),
  });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  const { allowDemoBookings, platformCommissionRate } = req.body || {};
  if (typeof allowDemoBookings === 'boolean') {
    await store.setSetting('allowDemoBookings', allowDemoBookings);
  }
  if (typeof platformCommissionRate === 'number') {
    if (!Number.isFinite(platformCommissionRate) || platformCommissionRate < 0 || platformCommissionRate > 0.5) {
      return res.status(400).json({ error: 'platformCommissionRate must be between 0 and 0.5' });
    }
    await store.setSetting('platformCommissionRate', platformCommissionRate);
  }
  res.json({
    allowDemoBookings: await store.getSetting('allowDemoBookings', false),
    platformCommissionRate: await getPlatformCommissionRate(),
  });
});

// ── User-submitted listings ──────────────────────────────────────────────────
// Any Pi user can submit a property. New listings start 'pending' and only
// show up publicly once an admin approves them via /api/admin/listings —
// unmoderated public listings on a payments-enabled site is a spam/abuse risk.

// Geocode a free-text address/location via Photon (Komoot's free OSM-based
// geocoder — no API key). Nominatim (OSMF's own instance) was tried first
// but silently blocks/rejects requests from Render's shared egress IPs per
// its strict usage policy; Photon runs on separate infrastructure and
// doesn't. Returns null on failure — callers must handle a missing
// coordinate rather than silently defaulting to some other real city,
// which would misrepresent where the property actually is.
async function geocode(query) {
  try {
    const params = new URLSearchParams({ q: query, limit: '1' });
    const res = await fetch(`https://photon.komoot.io/api/?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const feature = data.features && data.features[0];
    if (!feature) return null;
    const [lon, lat] = feature.geometry.coordinates;
    return [Number(lat), Number(lon)];
  } catch {
    return null;
  }
}

app.post('/api/listings', async (req, res) => {
  const l = req.body || {};
  const required = ['ownerUid', 'name', 'location', 'address', 'price', 'description'];
  const missing = required.filter((k) => !l[k]);
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });

  // Verify the caller actually owns the ownerUid they're submitting — without
  // this, anyone could create a listing (and future payouts) under someone
  // else's Pi identity.
  const callerUid = await resolvePiUid(req);
  if (!callerUid) return res.status(401).json({ error: 'Missing or invalid access token' });
  if (callerUid !== l.ownerUid) return res.status(403).json({ error: 'Forbidden' });

  const coordinates = await geocode(`${l.address}, ${l.location}`) || await geocode(l.location);

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
    coordinates,
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

app.get('/api/listings/owner/:piUid', requirePiIdentity('piUid'), async (req, res) => {
  res.json(await store.getListingsByOwner(req.params.piUid));
});

app.get('/api/listings/:id', async (req, res) => {
  const listing = await store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved') return res.status(404).json({ error: 'Not found' });
  res.json(listing);
});

// ── Listings: host-managed blocked date ranges ──────────────────────────────
// Lets a host mark dates unavailable (renovation, booked elsewhere, etc.)
// independent of guest bookings. Checked by both the availability endpoint
// (pre-payment) and booking creation (defense-in-depth).
app.post('/api/listings/:id/block-dates', async (req, res) => {
  const { checkIn, checkOut } = req.body || {};
  if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn, checkOut required' });

  const callerUid = await resolvePiUid(req);
  if (!callerUid) return res.status(401).json({ error: 'Missing or invalid access token' });

  const listing = await store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  if (listing.ownerUid !== callerUid) return res.status(403).json({ error: 'Forbidden' });
  if (new Date(checkIn) >= new Date(checkOut)) return res.status(400).json({ error: 'checkOut must be after checkIn' });

  const blockedRanges = [...(listing.blockedRanges || []), { checkIn, checkOut }];
  const updated = await store.updateListing(req.params.id, { blockedRanges });
  res.json(updated);
});

app.post('/api/listings/:id/unblock-dates', async (req, res) => {
  const { index } = req.body || {};
  if (index == null) return res.status(400).json({ error: 'index required' });

  const callerUid = await resolvePiUid(req);
  if (!callerUid) return res.status(401).json({ error: 'Missing or invalid access token' });

  const listing = await store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  if (listing.ownerUid !== callerUid) return res.status(403).json({ error: 'Forbidden' });

  const blockedRanges = (listing.blockedRanges || []).filter((_, i) => i !== Number(index));
  const updated = await store.updateListing(req.params.id, { blockedRanges });
  res.json(updated);
});

// ── Reviews ──────────────────────────────────────────────────────────────────
// A review can only be left once per booking, only by the guest who made it,
// and only after the stay's checkout date has passed — no reviewing a stay
// that hasn't happened yet, and no one but the actual guest can post one.
// Must be registered before /api/reviews/:hotelId — otherwise Express would
// match "summary" as a hotelId and this route would never be reached.
app.get('/api/reviews/summary', async (req, res) => {
  const hotelIds = String(req.query.hotelIds || '').split(',').filter(Boolean);
  if (!hotelIds.length) return res.json({});
  res.json(await store.getReviewSummaries(hotelIds));
});

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

// ── Admin: review moderation ────────────────────────────────────────────────
app.get('/api/admin/reviews', requireAdmin, async (_req, res) => {
  res.json(await store.getAllReviews());
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const deleted = await store.deleteReview(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
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
      console.log(`Platform commission (default, overridable in /admin): ${(DEFAULT_PLATFORM_COMMISSION_RATE * 100).toFixed(1)}%`);
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
