const test = require('node:test');
const assert = require('node:assert/strict');

// Exercises the in-memory storage path (no DATABASE_URL), which is what this
// deployment currently runs on. The Postgres path enforces the same rules via
// a unique index and a conditional UPDATE.
const store = require('./store');

function booking(overrides = {}) {
  return {
    id: `B-${Math.random().toString(36).slice(2)}`,
    piUid: 'guest-1',
    hotelId: '1',
    roomType: 'standard',
    checkIn: '2026-09-01',
    checkOut: '2026-09-05',
    status: 'confirmed',
    totalPi: 100,
    ...overrides,
  };
}

test('one Pi payment can only fund one booking', async () => {
  const paymentId = `pay-${Math.random().toString(36).slice(2)}`;
  await store.createBooking(booking({ paymentId }));

  await assert.rejects(
    () => store.createBooking(booking({ paymentId })),
    store.DuplicatePaymentError
  );
});

test('concurrent bookings with the same payment: only one survives', async () => {
  // The route checks for a duplicate, then awaits a network call to Pi before
  // inserting — two requests can both pass that check. createBooking is the
  // gap-free point that must still reject the second.
  const paymentId = `pay-${Math.random().toString(36).slice(2)}`;
  const results = await Promise.allSettled([
    store.createBooking(booking({ paymentId })),
    store.createBooking(booking({ paymentId })),
    store.createBooking(booking({ paymentId })),
  ]);

  const created = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(created.length, 1, 'exactly one booking should be created');
  assert.equal(rejected.length, 2);
  for (const r of rejected) {
    assert.ok(r.reason instanceof store.DuplicatePaymentError);
  }
});

test('bookings without a payment id are not treated as duplicates', async () => {
  await store.createBooking(booking());
  await store.createBooking(booking());
  // Demo bookings carry no paymentId — they must not collide with each other.
});

test('a refund can only be claimed once', async () => {
  const b = booking();
  await store.createBooking(b);

  const first = await store.claimRefund(b.id);
  const second = await store.claimRefund(b.id);

  assert.ok(first, 'first claim should win');
  assert.equal(first.refundStatus, 'processing');
  assert.equal(second, null, 'second claim must lose');
});

test('concurrent cancellations produce exactly one refund', async () => {
  const b = booking();
  await store.createBooking(b);

  const claims = await Promise.all([
    store.claimRefund(b.id),
    store.claimRefund(b.id),
    store.claimRefund(b.id),
  ]);

  assert.equal(claims.filter(Boolean).length, 1, 'only one refund may be sent');
});

test('claiming a refund on a missing booking returns null', async () => {
  assert.equal(await store.claimRefund('does-not-exist'), null);
});
