const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PI_USD_RATE,
  TAX_RATE,
  usdToPi,
  nightsBetween,
  expectedTotalPi,
  isUnderpaid,
} = require('./pricing');

test('converts USD to Pi at the configured rate', () => {
  assert.equal(usdToPi(15), 100); // at 0.15 $/π
  assert.equal(usdToPi(0), 0);
});

test('counts whole nights between dates', () => {
  assert.equal(nightsBetween('2026-09-01', '2026-09-05'), 4);
  assert.equal(nightsBetween('2026-09-01', '2026-09-02'), 1);
});

test('rejects date ranges that are not a real stay', () => {
  assert.equal(nightsBetween('2026-09-05', '2026-09-01'), null); // backwards
  assert.equal(nightsBetween('2026-09-01', '2026-09-01'), null); // zero nights
  assert.equal(nightsBetween('nonsense', '2026-09-01'), null);
});

test('matches the price a guest is shown', () => {
  // $100/night × 4 nights = $400 subtotal, +10% tax = $40.
  // Subtotal and tax are converted separately, as the booking page does.
  const expected = usdToPi(400) + usdToPi(40);
  assert.equal(expectedTotalPi(100, '2026-09-01', '2026-09-05'), expected);
});

test('returns null rather than a price for nonsense input', () => {
  assert.equal(expectedTotalPi(0, '2026-09-01', '2026-09-05'), null);
  assert.equal(expectedTotalPi(-50, '2026-09-01', '2026-09-05'), null);
  assert.equal(expectedTotalPi(NaN, '2026-09-01', '2026-09-05'), null);
  assert.equal(expectedTotalPi('abc', '2026-09-01', '2026-09-05'), null);
  assert.equal(expectedTotalPi(100, '2026-09-05', '2026-09-01'), null);
});

test('accepts payment of the full expected amount', () => {
  const expected = expectedTotalPi(100, '2026-09-01', '2026-09-05');
  assert.equal(isUnderpaid(expected, expected), false);
});

test('catches a guest paying a token amount for an expensive stay', () => {
  // The attack this exists for: pay 0.01 π, hold a $400 booking, and have the
  // host paid 0.01 π minus commission.
  const expected = expectedTotalPi(100, '2026-09-01', '2026-09-05');
  assert.equal(isUnderpaid(0.01, expected), true);
  assert.equal(isUnderpaid(expected / 2, expected), true);
});

test('tolerates small shortfalls from rounding', () => {
  const expected = expectedTotalPi(100, '2026-09-01', '2026-09-05');
  assert.equal(isUnderpaid(expected - 0.01, expected), false);
  assert.equal(isUnderpaid(expected * 0.995, expected), false);
});

test('overpayment is not underpayment', () => {
  const expected = expectedTotalPi(100, '2026-09-01', '2026-09-05');
  assert.equal(isUnderpaid(expected * 2, expected), false);
});

test('cannot judge a payment when the expected price is unknown', () => {
  // Demo hotels have no server-side price; nothing to compare against.
  assert.equal(isUnderpaid(50, null), false);
  assert.equal(isUnderpaid(NaN, 100), false);
});

test('rates are sane', () => {
  assert.ok(PI_USD_RATE > 0, 'a zero rate would divide by zero');
  assert.ok(TAX_RATE >= 0 && TAX_RATE < 1);
});
