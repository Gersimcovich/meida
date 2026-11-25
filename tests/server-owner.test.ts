import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.ts';
import { Store } from '../server/store.ts';
import { OwnerAuth } from '../server/owner.ts';
import { ProviderError } from '../server/auth.ts';

const password = 'test-owner-password-over-20-characters';
const config = (ownerPassword = password) => loadConfig({ HOST: '0.0.0.0', APP_ORIGIN: 'https://meida.example', OWNER_PASSWORD: ownerPassword });
const request = (token = '') => ({ headers: { cookie: `meida_owner=${token}` } });
const status = (code: number) => (error: unknown) => error instanceof ProviderError && error.status === code;

test('hosted login persists only token hashes and protects browser cookies', async () => {
  const store = new Store(':memory:');
  try {
    const owner = new OwnerAuth(config(), store);
    assert.equal(owner.required, true);
    assert.equal(owner.session(request()), false);
    await assert.rejects(owner.login('wrong-password', '127.0.0.1'), status(401));
    const token = await owner.login(password, '127.0.0.1');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(owner.session(request(token)), true);
    assert.equal(owner.session(request('0'.repeat(64))), false);
    assert.equal(owner.session({ headers: { cookie: `meida_owner=${token}; meida_owner=${token}` } }), false);
    const saved = JSON.stringify(store.get('ownerSessions', {}));
    assert(!saved.includes(token));
    assert(!saved.includes(password));
    assert.deepEqual(owner.cookieOptions, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 12 * 60 * 60_000 });
    owner.logout(request(token));
    assert.equal(owner.session(request(token)), false);
  } finally { store.close(); }
});

test('sessions survive restart but expire at 12 hours and password rotation revokes them', async () => {
  const store = new Store(':memory:');
  let clock = 1_800_000_000_000;
  try {
    const owner = new OwnerAuth(config(), store, () => clock);
    const token = await owner.login(password, 'client');
    assert.equal(new OwnerAuth(config(), store, () => clock).session(request(token)), true);
    clock += 12 * 60 * 60_000;
    assert.equal(owner.session(request(token)), false);
    const replacement = await owner.login(password, 'client');
    const rotated = new OwnerAuth(config('a-different-test-owner-password'), store, () => clock);
    assert.equal(rotated.session(request(replacement)), false);
    assert.deepEqual(store.get('ownerSessions', {}), {});
  } finally { store.close(); }
});

test('per-client throttling reserves concurrent attempts and recovers after 15 minutes', async () => {
  const store = new Store(':memory:');
  let clock = 1_800_000_000_000;
  try {
    const owner = new OwnerAuth(config(), store, () => clock);
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => owner.login('wrong', 'same-client')));
    assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.status === 401).length, 5);
    assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.status === 429).length, 1);
    await assert.rejects(owner.login(password, 'same-client'), status(429));
    clock += 15 * 60_000 + 1;
    assert.equal(owner.session(request(await owner.login(password, 'same-client'))), true);
  } finally { store.close(); }
});

test('global attempt limit bounds distinct clients and oversized inputs are rejected', async () => {
  const store = new Store(':memory:');
  try {
    const owner = new OwnerAuth(config(), store);
    // Invalid-length attempts still count and avoid expensive password derivation.
    for (let i = 0; i < 30; i++) await assert.rejects(owner.login('x'.repeat(1025), `client-${i}`), status(401));
    await assert.rejects(owner.login(password, 'new-client'), status(429));
  } finally { store.close(); }
});

test('loopback mode does not require or create an owner session', async () => {
  const store = new Store(':memory:');
  try {
    const owner = new OwnerAuth(loadConfig({}), store);
    assert.equal(owner.required, false);
    assert.equal(owner.session(request()), true);
    owner.logout(request('a'.repeat(64)));
    assert.deepEqual(store.get('ownerSessions', {}), {});
    await assert.rejects(owner.login(password, 'client'), status(400));
  } finally { store.close(); }
});
