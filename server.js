const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;
const PI_SERVER_API_KEY = process.env.PI_SERVER_API_KEY;

app.use(express.json());
app.use(cors({
  origin: [
    'https://stayfind-pi-booking.onrender.com',
    'http://localhost:5173',
    'http://localhost:5174',
  ],
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/payments/approve/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  if (!PI_SERVER_API_KEY) {
    console.log('[Mock] Approve payment', paymentId);
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
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error('[Approve] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/payments/complete/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  const { txid } = req.body;
  if (!PI_SERVER_API_KEY) {
    console.log('[Mock] Complete payment', paymentId, 'txid:', txid);
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
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error('[Complete] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`StayFind API listening on port ${PORT}`);
  if (!PI_SERVER_API_KEY) {
    console.warn('PI_SERVER_API_KEY not set — running in mock mode');
  }
});
