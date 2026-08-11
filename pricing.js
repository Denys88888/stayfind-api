/**
 * Canonical pricing for user-submitted listings.
 *
 * This is the authority: the frontend reads the rates from /api/config rather
 * than carrying its own copy, so the price a guest is shown and the price the
 * server expects can't drift apart. Keeping a second copy in the browser is
 * also what let a guest pay less than the listing is worth — the browser
 * decides what to charge, so the server has to be able to check it.
 */

/** Pi's assumed USD value. Overridable per-deployment as the market moves. */
const PI_USD_RATE = Number(process.env.PI_USD_RATE || '0.15');

/** Service fee added on top of the nightly subtotal. */
const TAX_RATE = Number(process.env.BOOKING_TAX_RATE || '0.10');

/** How far under the expected total a payment may fall before it's suspect.
 *  Covers rounding and a rate change landing mid-checkout, nothing more. */
const UNDERPAYMENT_TOLERANCE = 0.02; // 2%

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function usdToPi(usd) {
  return round2(usd / PI_USD_RATE);
}

/** Whole nights between two ISO dates (YYYY-MM-DD). */
function nightsBetween(checkIn, checkOut) {
  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const nights = Math.round((end - start) / 86400000);
  return nights > 0 ? nights : null;
}

/**
 * What a stay should cost in Pi.
 *
 * Mirrors the guest-facing breakdown exactly — subtotal and tax are each
 * converted to Pi and then added, rather than converting the sum, because
 * that is what the booking page shows and charges.
 *
 * @returns {number|null} expected total in Pi, or null if the inputs make no sense
 */
function expectedTotalPi(pricePerNightUsd, checkIn, checkOut) {
  const price = Number(pricePerNightUsd);
  if (!Number.isFinite(price) || price <= 0) return null;

  const nights = nightsBetween(checkIn, checkOut);
  if (!nights) return null;

  const subtotalUsd = price * nights;
  const taxesUsd = round2(subtotalUsd * TAX_RATE);
  return round2(usdToPi(subtotalUsd) + usdToPi(taxesUsd));
}

/** True when `paidPi` falls short of the expected total beyond tolerance. */
function isUnderpaid(paidPi, expectedPi) {
  if (!Number.isFinite(paidPi) || !Number.isFinite(expectedPi)) return false;
  return paidPi < expectedPi * (1 - UNDERPAYMENT_TOLERANCE);
}

module.exports = {
  PI_USD_RATE,
  TAX_RATE,
  UNDERPAYMENT_TOLERANCE,
  usdToPi,
  nightsBetween,
  expectedTotalPi,
  isUnderpaid,
  round2,
};
