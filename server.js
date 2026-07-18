const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;
const PI_SERVER_API_KEY = process.env.PI_SERVER_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || 'stayfind-admin-dev';

app.use(express.json());
app.use(cors({
  origin: [
    'https://stayfind-pi-booking.onrender.com',
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

app.listen(PORT, () => {
  console.log(`StayFind API listening on port ${PORT}`);
  if (!PI_SERVER_API_KEY) {
    console.warn('PI_SERVER_API_KEY not set — running in mock mode');
  }
  console.log(`Admin key: ${ADMIN_KEY === 'stayfind-admin-dev' ? 'DEFAULT (set ADMIN_KEY env var!)' : 'CUSTOM'}`);
});
