const test = require('node:test');
const assert = require('node:assert/strict');

// Exercises the in-memory path (no DATABASE_URL). The Postgres path enforces
// the same rule with an exclusive table lock inside a transaction, because a
// plain read-then-write would let two simultaneous claims both through.
const store = require('./store');

test('nobody is an admin before the seat is claimed', async () => {
  assert.equal(await store.countAdmins(), 0);
  assert.equal(await store.isAdminUid('pi_anyone'), false);
});

test('the first claim wins and makes that uid an admin', async () => {
  const row = await store.claimFirstAdmin('pi_owner', 'Cherry19899');

  assert.ok(row, 'the first claim should be granted');
  assert.equal(row.piUid, 'pi_owner');
  assert.equal(await store.isAdminUid('pi_owner'), true);
});

test('a second claim by someone else is refused', async () => {
  // Runs after the test above, so a seat is already taken.
  assert.equal(await store.claimFirstAdmin('pi_impostor', 'Cherry19899'), null);
  assert.equal(await store.isAdminUid('pi_impostor'), false);
});

test('the same username on a different uid gets nothing', async () => {
  // The whole point of storing uids: an account that manages to present the
  // owner's username later must not inherit the seat.
  assert.equal(await store.isAdminUid('pi_owner_lookalike'), false);
  assert.equal(await store.claimFirstAdmin('pi_owner_lookalike', 'cherry19899'), null);
  assert.equal(await store.isAdminUid('pi_owner_lookalike'), false);
});

test('concurrent claims produce exactly one admin', async () => {
  // Fresh module instance so this starts from an empty table.
  delete require.cache[require.resolve('./store')];
  const fresh = require('./store');

  const results = await Promise.all([
    fresh.claimFirstAdmin('pi_a', 'a'),
    fresh.claimFirstAdmin('pi_b', 'b'),
    fresh.claimFirstAdmin('pi_c', 'c'),
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'only one seat may be handed out');
  assert.equal(await fresh.countAdmins(), 1);
});

test('an empty uid is never treated as an admin', async () => {
  // resolvePiIdentity returns null for a bad token; if that ever leaks through
  // as an empty uid it must not match a row.
  assert.equal(await store.isAdminUid(''), false);
  assert.equal(await store.isAdminUid(null), false);
  assert.equal(await store.isAdminUid(undefined), false);
  await assert.rejects(() => store.claimFirstAdmin(null, 'Cherry19899'));
});
