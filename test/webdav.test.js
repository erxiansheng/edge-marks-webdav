import test from 'node:test';
import assert from 'node:assert/strict';
import { completeChunkUpload, listDirectory, uploadChunk } from '../server/webdav.js';

const session = { baseUrl: 'https://mock.example/dav', username: 'demo-user', password: 'demo-pass' };
const env = { WEBDAV_CHUNK_BYTES: String(4 * 1024 * 1024), WEBDAV_TEMP_DIR: '/.edgeone-upload', WEBDAV_MAX_UPLOAD_BYTES: String(1024 * 1024 * 1024) };

const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/dav/hello.txt</d:href><d:propstat><d:prop><d:displayname>hello.txt</d:displayname><d:resourcetype/><d:getcontentlength>5</d:getcontentlength><d:getetag>"v1"</d:getetag></d:prop></d:propstat></d:response>
</d:multistatus>`;

test('listDirectory sends Basic auth and parses result', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://mock.example/dav/');
    assert.equal(init.method, 'PROPFIND');
    assert.equal(init.headers.get('Authorization'), 'Basic ZGVtby11c2VyOmRlbW8tcGFzcw==');
    return new Response(xml, { status: 207 });
  };
  try {
    const result = await listDirectory(session, '/');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, 'hello.txt');
  } finally { globalThis.fetch = original; }
});

test('chunk upload writes to hidden WebDAV temp directory', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, method: init.method, length: init.headers.get('Content-Length') }; return new Response('', { status: 201 }); };
  try {
    const result = await uploadChunk(env, session, '0123456789abcdef0123456789abcdef', 3, new TextEncoder().encode('abc'));
    assert.equal(result.index, 3);
    assert.equal(seen.url, 'https://mock.example/dav/.edgeone-upload/0123456789abcdef0123456789abcdef/000003.part');
    assert.equal(seen.length, '3');
  } finally { globalThis.fetch = original; }
});

test('large upload completion streams WebDAV chunks into one PUT then deletes temp directory', async () => {
  const original = globalThis.fetch;
  const uploadId = '0123456789abcdef0123456789abcdef';
  const chunks = new Map([
    ['https://mock.example/dav/.edgeone-upload/' + uploadId + '/000000.part', new TextEncoder().encode('hello ')],
    ['https://mock.example/dav/.edgeone-upload/' + uploadId + '/000001.part', new TextEncoder().encode('world')]
  ]);
  let merged = '';
  let deleted = false;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'MKCOL') return new Response('', { status: 405 });
    if (init.method === 'GET' && chunks.has(url)) return new Response(chunks.get(url), { status: 200 });
    if (init.method === 'PUT' && url === 'https://mock.example/dav/final.txt') {
      merged = await new Response(init.body).text();
      return new Response('', { status: 201 });
    }
    if (init.method === 'DELETE' && url === `https://mock.example/dav/.edgeone-upload/${uploadId}/`) { deleted = true; return new Response('', { status: 204 }); }
    return new Response('', { status: 500 });
  };
  try {
    const result = await completeChunkUpload(env, session, { uploadId, path: '/final.txt', totalChunks: 2, size: 11, contentType: 'text/plain' });
    assert.equal(result.created, true);
    assert.equal(merged, 'hello world');
    assert.equal(deleted, true);
  } finally { globalThis.fetch = original; }
});
