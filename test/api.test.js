import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as connectSession } from '../cloud-functions/api/webdav/session.js';
import { onRequestPost as createDownloadUrl } from '../cloud-functions/api/webdav/download-url.js';
import { openToken } from '../shared/session.js';

const env = {
  WEBDAV_BASE_URL: 'https://mock.example/dav',
  WEBDAV_USERNAME: 'alice',
  WEBDAV_PASSWORD: 'p@ssword',
  WEBDAV_SESSION_SECRET: 'unit-test-secret-that-is-long-enough',
  WEBDAV_ALLOWED_HOSTS: 'mock.example',
  CDN_DOWNLOAD_HOST: 'dl.example.com',
  CDN_AUTH_KEY: 'cdn-secret-key',
  CDN_TOKEN_VALID_SECONDS: '3600'
};

const statXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/file.zip</d:href><d:propstat><d:prop><d:displayname>file.zip</d:displayname><d:resourcetype/><d:getcontentlength>123</d:getcontentlength><d:getetag>"abc"</d:getetag><d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>`;

test('session endpoint reads WebDAV credentials from env and session contains no credentials', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://mock.example/dav/');
    assert.ok(init.headers.get('Authorization')?.startsWith('Basic '));
    return new Response(statXml, { status: 207 });
  };
  try {
    const response = await connectSession({ request: new Request('https://app.example/api/webdav/session', { method: 'POST' }), env });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.connection.source, 'environment');
    assert.equal(JSON.stringify(body).includes(env.WEBDAV_PASSWORD), false);
    const decoded = await openToken(body.session, env.WEBDAV_SESSION_SECRET, 'webdav-session');
    assert.equal(decoded.scope, 'configured-webdav');
    assert.equal('username' in decoded, false);
    assert.equal('password' in decoded, false);
    assert.equal('baseUrl' in decoded, false);
  } finally { globalThis.fetch = original; }
});

test('download-url returns stable file path on CDN host and ticket contains no WebDAV credentials', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(statXml, { status: 207 });
  try {
    const sessionResponse = await connectSession({ request: new Request('https://app.example/api/webdav/session', { method: 'POST' }), env });
    const sessionBody = await sessionResponse.json();
    const response = await createDownloadUrl({ request: new Request('https://app.example/api/webdav/download-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: sessionBody.session, path: '/file.zip' }) }), env });
    const body = await response.json();
    assert.equal(body.mode, 'edgeone-native-cdn');
    const url = new URL(body.url);
    assert.equal(url.host, 'dl.example.com');
    assert.match(url.pathname, /^\/download\/[a-f0-9]{64}$/);
    assert.equal(url.searchParams.get('token')?.length, 32);
    const ticket = url.searchParams.get('ticket');
    assert.ok(ticket);
    assert.ok(url.searchParams.get('t'));
    const decodedTicket = await openToken(ticket, env.WEBDAV_SESSION_SECRET, 'download-ticket');
    assert.equal('username' in decodedTicket, false);
    assert.equal('password' in decodedTicket, false);
    assert.equal('baseUrl' in decodedTicket, false);
    assert.equal(decodedTicket.path, '/file.zip');
  } finally { globalThis.fetch = original; }
});

import { onRequestPost as uploadChunkPost } from '../cloud-functions/api/webdav/upload/chunk.js';
import { onRequestPost as uploadFilePost } from '../cloud-functions/api/webdav/file.js';
import { readJson } from '../server/http.js';

test('readJson reuses a Makers pre-parsed body without consuming Request again', async () => {
  const parsed = { hello: 'world' };
  const request = {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: parsed,
    bodyUsed: true,
    json() { throw new Error('must not be called'); }
  };
  assert.deepEqual(await readJson(request), parsed);
});

test('chunk endpoint accepts JSON Base64 and writes decoded bytes to WebDAV', async () => {
  const original = globalThis.fetch;
  const payload = Buffer.from('chunk-data-123');
  let sessionToken;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PROPFIND') return new Response(statXml, { status: 207 });
    assert.match(String(url), /\/\.edgeone-upload\/[a-f0-9]{32}\/000008\.part$/);
    assert.equal(init.method, 'PUT');
    assert.deepEqual(Buffer.from(init.body), payload);
    return new Response(null, { status: 201 });
  };
  try {
    const sessionResponse = await connectSession({ request: new Request('https://app.example/api/webdav/session', { method: 'POST' }), env });
    sessionToken = (await sessionResponse.json()).session;
    const uploadId = '29be55588a5644a5b1e70955aff51eeb';
    const request = new Request('https://app.example/api/webdav/upload/chunk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionToken, uploadId, index: 8, dataBase64: payload.toString('base64') })
    });
    const response = await uploadChunkPost({ request, env });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.index, 8);
    assert.equal(body.transport, 'json-base64');
  } finally { globalThis.fetch = original; }
});

test('direct file endpoint accepts JSON Base64 and avoids raw Request arrayBuffer', async () => {
  const original = globalThis.fetch;
  const payload = Buffer.from('small-file-data');
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PROPFIND') return new Response(statXml, { status: 207 });
    assert.equal(String(url), 'https://mock.example/dav/small.txt');
    assert.equal(init.method, 'PUT');
    assert.deepEqual(Buffer.from(init.body), payload);
    return new Response(null, { status: 201 });
  };
  try {
    const sessionResponse = await connectSession({ request: new Request('https://app.example/api/webdav/session', { method: 'POST' }), env });
    const session = (await sessionResponse.json()).session;
    const request = new Request('https://app.example/api/webdav/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, path: '/small.txt', contentType: 'text/plain', dataBase64: payload.toString('base64') })
    });
    const response = await uploadFilePost({ request, env });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.transport, 'json-base64');
  } finally { globalThis.fetch = original; }
});

import { getChunkBytes } from '../server/config.js';

test('4 MiB Base64 JSON chunk stays below 6 MiB Cloud Function body limit and chunk config is capped', () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  const payload = JSON.stringify({
    session: 'x'.repeat(256),
    uploadId: 'a'.repeat(32),
    index: 8,
    dataBase64: bytes.toString('base64')
  });
  assert.ok(Buffer.byteLength(payload) < 6 * 1024 * 1024);
  assert.equal(getChunkBytes({ WEBDAV_CHUNK_BYTES: String(5 * 1024 * 1024) }), 4 * 1024 * 1024);
});


test('download-url rejects incomplete CDN config instead of leaking internal SCF origin', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(statXml, { status: 207 });
  try {
    const incompleteEnv = { ...env, CDN_AUTH_KEY: '' };
    const sessionResponse = await connectSession({ request: new Request('https://test6.example/api/webdav/session', { method: 'POST' }), env: incompleteEnv });
    const sessionBody = await sessionResponse.json();
    const response = await createDownloadUrl({
      request: new Request('https://internal.pages-scf.example/api/webdav/download-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionBody.session, path: '/file.zip' })
      }),
      env: incompleteEnv
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'CDN_AUTH_KEY_MISSING');
    assert.match(body.error.message, /CDN_AUTH_KEY/);
    assert.equal(JSON.stringify(body).includes('internal.pages-scf.example'), false);
  } finally { globalThis.fetch = original; }
});

test('download-url without CDN returns a relative public-site path, never internal SCF origin', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(statXml, { status: 207 });
  try {
    const noCdnEnv = { ...env, CDN_DOWNLOAD_HOST: '', CDN_AUTH_KEY: '' };
    const sessionResponse = await connectSession({ request: new Request('https://test6.example/api/webdav/session', { method: 'POST' }), env: noCdnEnv });
    const sessionBody = await sessionResponse.json();
    const response = await createDownloadUrl({
      request: new Request('https://internal.pages-scf.example/api/webdav/download-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionBody.session, path: '/file.zip' })
      }),
      env: noCdnEnv
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, 'origin-stream');
    assert.match(body.url, /^\/download\/[a-f0-9]{64}\?ticket=/);
    assert.equal(body.url.includes('internal.pages-scf.example'), false);
  } finally { globalThis.fetch = original; }
});
