import test from 'node:test';
import assert from 'node:assert/strict';
import { openToken } from '../shared/session.js';
import { createWebDavSession, readWebDavSession } from '../server/session.js';
import { getWebDavCredentials } from '../server/config.js';
import { normalizeBaseUrl, normalizeDavPath } from '../shared/webdav-common.js';

const env = {
  WEBDAV_BASE_URL: 'https://webdav.example.com/dav',
  WEBDAV_USERNAME: 'alice',
  WEBDAV_PASSWORD: 'secret-pass',
  WEBDAV_SESSION_SECRET: 'unit-test-secret-that-is-long-enough'
};

test('session token contains no WebDAV credentials and server resolves credentials from env', async () => {
  const token = await createWebDavSession(env);
  assert.equal(token.includes('secret-pass'), false);
  const payload = await openToken(token, env.WEBDAV_SESSION_SECRET, 'webdav-session');
  assert.equal(payload.scope, 'configured-webdav');
  assert.equal('username' in payload, false);
  assert.equal('password' in payload, false);
  const credentials = await readWebDavSession(token, env);
  assert.deepEqual(credentials, getWebDavCredentials(env));
});

test('fixed WebDAV config requires base URL, username and password', () => {
  assert.throws(() => getWebDavCredentials({ WEBDAV_BASE_URL: 'https://webdav.example.com/dav' }), /WEBDAV_USERNAME/);
  assert.equal(getWebDavCredentials(env).baseUrl, 'https://webdav.example.com/dav');
});

test('WebDAV origin policy blocks private network literals', () => {
  assert.throws(() => normalizeBaseUrl('https://127.0.0.1/webdav'), /SSRF/);
  assert.throws(() => normalizeBaseUrl('https://192.168.1.10/dav'), /SSRF/);
  assert.equal(normalizeBaseUrl('https://webdav.example.com/dav'), 'https://webdav.example.com/dav');
});

test('path normalization rejects traversal', () => {
  assert.throws(() => normalizeDavPath('/a/../b'), /\.\./);
  assert.equal(normalizeDavPath('/中文/a.txt'), '/中文/a.txt');
});
