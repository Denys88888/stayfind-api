const test = require('node:test');
const assert = require('node:assert/strict');
const { splitBookingPayment, round2 } = require('./money');

test('splits a payment into commission and host payout', () => {
  const { platformFeeAmount, hostPayoutAmount } = splitBookingPayment(100, 0.08);
  assert.equal(platformFeeAmount, 8);
  assert.equal(hostPayoutAmount, 92);
});

test('the two parts always add back up to the total', () => {
  // The invariant that matters: the platform must never pay out more than it
  // took in, and must never keep a sliver of the host's money to rounding.
  const rates = [0, 0.02, 0.025, 0.03, 0.075, 0.08, 0.1, 0.15, 0.333, 0.5];
  for (let cents = 1; cents <= 5000; cents++) {
    const total = round2(cents / 100);
    for (const rate of rates) {
      const { platformFeeAmount, hostPayoutAmount } = splitBookingPayment(total, rate);
      assert.equal(
        round2(platformFeeAmount + hostPayoutAmount),
        total,
        `${total} π at ${rate}: ${platformFeeAmount} + ${hostPayoutAmount} != ${total}`
      );
      assert.ok(platformFeeAmount >= 0, `negative fee at ${total}/${rate}`);
      assert.ok(hostPayoutAmount >= 0, `negative payout at ${total}/${rate}`);
    }
  }
});

test('0% commission gives the host everything', () => {
  const { platformFeeAmount, hostPayoutAmount } = splitBookingPayment(57.31, 0);
  assert.equal(platformFeeAmount, 0);
  assert.equal(hostPayoutAmount, 57.31);
});

test('50% commission splits evenly', () => {
  const { platformFeeAmount, hostPayoutAmount } = splitBookingPayment(80, 0.5);
  assert.equal(platformFeeAmount, 40);
  assert.equal(hostPayoutAmount, 40);
});

test('handles amounts where floating point misbehaves', () => {
  // 0.1 + 0.2 !== 0.3 territory — naive rounding leaks fractions of a Pi here.
  const { platformFeeAmount, hostPayoutAmount } = splitBookingPayment(0.3, 0.1);
  assert.equal(platformFeeAmount, 0.03);
  assert.equal(hostPayoutAmount, 0.27);
});

test('rejects NaN amount rather than producing NaN payouts', () => {
  // A NaN here would be written straight into hostPayoutAmount and later
  // handed to the A2U payout call.
  assert.throws(() => splitBookingPayment(NaN, 0.08), TypeError);
});

test('rejects NaN commission rate', () => {
  assert.throws(() => splitBookingPayment(100, NaN), RangeError);
});

test('rejects a zero or negative payment', () => {
  assert.throws(() => splitBookingPayment(0, 0.08), TypeError);
  assert.throws(() => splitBookingPayment(-50, 0.08), TypeError);
});

test('rejects a commission rate outside 0..50%', () => {
  assert.throws(() => splitBookingPayment(100, 0.51), RangeError);
  assert.throws(() => splitBookingPayment(100, 1), RangeError);
  assert.throws(() => splitBookingPayment(100, -0.1), RangeError);
});

test('rejects a non-numeric amount', () => {
  assert.throws(() => splitBookingPayment('100', 0.08), TypeError);
  assert.throws(() => splitBookingPayment(undefined, 0.08), TypeError);
  assert.throws(() => splitBookingPayment(Infinity, 0.08), TypeError);
});
