import test from 'node:test';
import assert from 'node:assert/strict';
import { sealToken } from '../shared/session.js';
import { onRequestGet } from '../edge-functions/download/[fileId].js';

const secret = 'unit-test-secret-that-is-long-enough';

test('download Edge Function reads WebDAV credentials from env, forwards Range and streams 206', async () => {
  const fileId = 'a'.repeat(64);
  const ticket = await sealToken({ kind: 'download-ticket', path: '/big.bin', fileId, filename: 'big.bin' }, secret, 3600);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://mock.example/dav/big.bin');
    assert.equal(init.headers.get('Range'), 'bytes=0-1023');
    assert.ok(init.headers.get('Authorization')?.startsWith('Basic '));
    return new Response(new Uint8Array([1,2,3]), { status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-2/10000', 'Accept-Ranges': 'bytes' } });
  };
  try {
    const response = await onRequestGet({
      request: new Request(`https://origin.example/download/${fileId}?ticket=${encodeURIComponent(ticket)}`, { headers: { Range: 'bytes=0-1023' } }),
      params: { fileId },
      env: {
        WEBDAV_BASE_URL: 'https://mock.example/dav',
        WEBDAV_USERNAME: 'alice',
        WEBDAV_PASSWORD: 'secret',
        WEBDAV_SESSION_SECRET: secret,
        WEBDAV_ALLOWED_HOSTS: 'mock.example'
      }
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-2/10000');
    assert.match(response.headers.get('Cache-Control'), /s-maxage=2592000/);
  } finally { globalThis.fetch = original; }
});
