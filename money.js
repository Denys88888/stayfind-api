/**
 * Money math for bookings.
 *
 * Kept separate from the request handlers so it can be tested directly: these
 * few lines decide how much real Pi leaves the app wallet, and a rounding
 * mistake here is money lost or invented, not a cosmetic bug.
 *
 * Pi amounts are handled to 2 decimal places throughout.
 */

/** Round to 2dp, correcting for binary float representation (0.1+0.2 cases). */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Split a guest's payment into the platform's commission and the host's payout.
 *
 * The two parts are guaranteed to add back up to the original total, so the
 * platform can never pay out more than it took in (or quietly keep a cent of
 * the host's money to rounding).
 *
 * @param {number} totalPi  what the guest actually paid, in Pi
 * @param {number} rate     commission share, 0..0.5 (e.g. 0.08 = 8%)
 * @returns {{ platformFeeAmount: number, hostPayoutAmount: number }}
 */
function splitBookingPayment(totalPi, rate) {
  if (!Number.isFinite(totalPi) || totalPi <= 0) {
    throw new TypeError(`totalPi must be a positive finite number, got ${totalPi}`);
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.5) {
    throw new RangeError(`commission rate must be between 0 and 0.5, got ${rate}`);
  }

  const total = round2(totalPi);
  const platformFeeAmount = round2(total * rate);
  // Derived by subtraction rather than rounded independently, so the two
  // halves always reconcile exactly against the total.
  const hostPayoutAmount = round2(total - platformFeeAmount);

  return { platformFeeAmount, hostPayoutAmount };
}

module.exports = { splitBookingPayment, round2 };
