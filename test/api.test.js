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
  WEBDAV_INTERNAL_KEY: 'internal-secret-key-that-is-long-enough',
  WEBDAV_ALLOWED_HOSTS: 'mock.example',
  CDN_DOWNLOAD_HOST: 'dl.example.com',
  CDN_AUTH_KEY: 'cdn-secret-key',
  CDN_TOKEN_VALID_SECONDS: '3600',
  CDN_ORIGIN_KEY: 'origin-secret-key-that-is-long-enough',
  CDN_RANGE_BYTES: String(4 * 1024 * 1024)
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

test('download-url generates a versioned CDN path for Cloud Function origin with no credential ticket', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(statXml, { status: 207 });
  try {
    const sessionResponse = await connectSession({ request: new Request('https://app.example/api/webdav/session', { method: 'POST' }), env });
    const sessionBody = await sessionResponse.json();
    const response = await createDownloadUrl({ request: new Request('https://app.example/api/webdav/download-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: sessionBody.session, path: '/dir/file name.zip' }) }), env });
    const body = await response.json();
    assert.equal(body.mode, 'edgeone-cdn-native-direct-link');
    assert.equal(body.cdn.origin, 'makers-cloud-function');
    assert.equal(body.cdn.originProtected, true);
    assert.equal(body.cdn.originMaxRangeBytes, 4 * 1024 * 1024);
    assert.equal(body.cdn.browserRangeAssembly, false);
    const url = new URL(body.url);
    assert.equal(url.host, 'dl.example.com');
    assert.match(url.pathname, /^\/download\/[a-f0-9]{64}\/dir\/file%20name\.zip$/);
    assert.equal(url.searchParams.has('ticket'), false);
    assert.equal(url.searchParams.get('token')?.length, 32);
    assert.ok(url.searchParams.get('t'));
    assert.equal(JSON.stringify(body).includes(env.WEBDAV_PASSWORD), false);
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


test('download-url requires complete CDN configuration', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(statXml, { status: 207 });
  try {
    const noCdnEnv = { ...env, CDN_DOWNLOAD_HOST: '', CDN_AUTH_KEY: '', CDN_ORIGIN_KEY: '' };
    const sessionResponse = await connectSession({ request: new Request('https://test.example/api/webdav/session', { method: 'POST' }), env: noCdnEnv });
    const sessionBody = await sessionResponse.json();
    const response = await createDownloadUrl({
      request: new Request('https://internal.pages-scf.example/api/webdav/download-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionBody.session, path: '/file.zip' })
      }),
      env: noCdnEnv
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'CDN_NOT_CONFIGURED');
    assert.equal(JSON.stringify(body).includes('internal.pages-scf.example'), false);
  } finally { globalThis.fetch = original; }
});


import { onRequestGet as downloadOriginGet, parseSingleRange } from '../cloud-functions/download/[[path]].js';

test('Cloud download origin rejects direct access without CDN origin secret', async () => {
  const request = new Request('https://app.example/download/' + 'a'.repeat(64) + '/dir/file.zip', {
    method: 'GET',
    headers: { Range: 'bytes=0-1048575' }
  });
  const response = await downloadOriginGet({ request, env });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'CDN_ORIGIN_FORBIDDEN');
});

test('Cloud download origin forwards a 4 MiB Range to WebDAV and returns 206', async () => {
  const original = globalThis.fetch;
  const size = 4 * 1024 * 1024;
  const payload = new Uint8Array(size);
  payload[0] = 7;
  payload[size - 1] = 9;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), 'https://mock.example/dav/dir/file.zip');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('Range'), 'bytes=0-4194303');
    assert.ok(init.headers.get('Authorization')?.startsWith('Basic '));
    return new Response(payload, {
      status: 206,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(size),
        'Content-Range': 'bytes 0-4194303/8388608',
        'Accept-Ranges': 'bytes',
        'ETag': '"range-v1"'
      }
    });
  };
  try {
    const request = new Request('https://app.example/download/' + 'a'.repeat(64) + '/dir/file.zip', {
      method: 'GET',
      headers: {
        Range: 'bytes=0-4194303',
        'X-CDN-Origin-Key': env.CDN_ORIGIN_KEY
      }
    });
    const response = await downloadOriginGet({ request, env });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-4194303/8388608');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.match(response.headers.get('Content-Disposition'), /file\.zip/);
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(body.byteLength, size);
    assert.equal(body[0], 7);
    assert.equal(body[size - 1], 9);
  } finally { globalThis.fetch = original; }
});

test('Cloud download origin rejects a Range larger than 4 MiB', async () => {
  const request = new Request('https://app.example/download/' + 'b'.repeat(64) + '/big.bin', {
    method: 'GET',
    headers: {
      Range: 'bytes=0-4194304',
      'X-CDN-Origin-Key': env.CDN_ORIGIN_KEY
    }
  });
  const response = await downloadOriginGet({ request, env });
  assert.equal(response.status, 416);
  const body = await response.json();
  assert.equal(body.error.code, 'RANGE_TOO_LARGE');
});

test('Range parser accepts 3 MiB and 4 MiB but not more than configured maximum', () => {
  assert.equal(parseSingleRange('bytes=0-3145727', 4 * 1024 * 1024).length, 3 * 1024 * 1024);
  assert.equal(parseSingleRange('bytes=0-4194303', 4 * 1024 * 1024).length, 4 * 1024 * 1024);
  assert.throws(() => parseSingleRange('bytes=0-4194304', 4 * 1024 * 1024), /单次 Range/);
});

import { createWebDavSession } from '../server/session.js';
import { onRequestPost as internalDirectoryList } from '../cloud-functions/api/internal/webdav/list.js';
import { onRequestPost as edgeDirectoryList } from '../edge-functions/api/webdav/list.js';

const directoryXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/dav/dir/</d:href><d:propstat><d:prop><d:displayname>dir</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/dav/dir/a.txt</d:href><d:propstat><d:prop><d:displayname>a.txt</d:displayname><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getetag>"a1"</d:getetag></d:prop></d:propstat></d:response>
</d:multistatus>`;

test('internal directory Cloud Function rejects callers without WEBDAV_INTERNAL_KEY', async () => {
  const session = await createWebDavSession(env);
  const response = await internalDirectoryList({
    request: new Request('https://app.example/api/internal/webdav/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, path: '/dir/' })
    }),
    env
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'INTERNAL_ORIGIN_FORBIDDEN');
});

test('internal directory Cloud Function is the component that sends PROPFIND to WebDAV', async () => {
  const original = globalThis.fetch;
  const session = await createWebDavSession(env);
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls += 1;
    assert.equal(String(url), 'https://mock.example/dav/dir/');
    assert.equal(init.method, 'PROPFIND');
    assert.equal(init.headers.get('Depth'), '1');
    assert.ok(init.headers.get('Authorization')?.startsWith('Basic '));
    return new Response(directoryXml, { status: 207, headers: { 'Content-Type': 'application/xml' } });
  };
  try {
    const response = await internalDirectoryList({
      request: new Request('https://app.example/api/internal/webdav/list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WebDAV-Internal-Key': env.WEBDAV_INTERNAL_KEY
        },
        body: JSON.stringify({ session, path: '/dir/' })
      }),
      env
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.path, '/dir/');
    assert.equal(body.webdavOrigin, 'makers-cloud-function');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('Edge directory function uses KV and calls only the internal Cloud Function on MISS', async () => {
  const original = globalThis.fetch;
  const session = await createWebDavSession(env);
  const store = new Map();
  const kv = {
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value) { store.set(key, value); }
  };
  let fetchCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls += 1;
    assert.equal(String(url), 'https://app.example/api/internal/webdav/list');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-WebDAV-Internal-Key'], env.WEBDAV_INTERNAL_KEY);
    assert.equal(String(url).includes('mock.example'), false);
    const body = JSON.parse(init.body);
    assert.equal(body.session, session);
    assert.equal(body.path, '/dir/');
    return new Response(JSON.stringify({
      ok: true,
      path: '/dir/',
      items: [{ path: '/dir/a.txt', name: 'a.txt', type: 'file', size: 12 }],
      webdavOrigin: 'makers-cloud-function'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const pending = [];
    const context = {
      request: new Request('https://app.example/api/webdav/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, path: '/dir/' })
      }),
      env: { ...env, WEBDAV_KV: kv },
      waitUntil(promise) { pending.push(promise); }
    };
    const response = await edgeDirectoryList(context);
    await Promise.all(pending);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-KV-Cache'), 'MISS');
    assert.equal(response.headers.get('X-WebDAV-Origin'), 'CLOUD-FUNCTION');
    const body = await response.json();
    assert.equal(body.cache.hit, false);
    assert.equal(body.cache.webdavOrigin, 'makers-cloud-function');
    assert.equal(fetchCalls, 1);

    globalThis.fetch = async () => {
      throw new Error('KV HIT must not call Cloud Function or WebDAV');
    };
    const hitResponse = await edgeDirectoryList({
      request: new Request('https://app.example/api/webdav/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, path: '/dir/' })
      }),
      env: { ...env, WEBDAV_KV: kv },
      waitUntil() {}
    });
    assert.equal(hitResponse.status, 200);
    assert.equal(hitResponse.headers.get('X-KV-Cache'), 'HIT');
    assert.equal(hitResponse.headers.get('X-WebDAV-Origin'), 'NONE');
    const hitBody = await hitResponse.json();
    assert.equal(hitBody.cache.hit, true);
    assert.equal(hitBody.cache.webdavOrigin, 'none');
  } finally {
    globalThis.fetch = original;
  }
});
