import { authHeaders, basename, buildDavUrl, InputError, normalizeDavPath, parseMultiStatus, PROPFIND_BODY, WebDavError } from '../shared/webdav-common.js';
import { getChunkBytes, getMaxUploadBytes, getTempRoot, MAX_DIRECT_BYTES } from './config.js';

async function errorSnippet(response) { try { return (await response.text()).slice(0, 500); } catch { return ''; } }

export async function davFetch(session, path, init = {}, options = {}) {
  const headers = authHeaders(session, init.headers || {});
  const response = await fetch(buildDavUrl(session.baseUrl, path), { ...init, headers });
  const allowed = options.allowedStatuses || [];
  if (!response.ok && !allowed.includes(response.status)) {
    const detail = await errorSnippet(response);
    const authFailed = response.status === 401 || response.status === 403;
    throw new WebDavError(authFailed ? 'WebDAV 鉴权失败，请检查账号密码' : `WebDAV 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`, {
      status: authFailed ? 401 : 502,
      upstreamStatus: response.status,
      code: authFailed ? 'WEBDAV_AUTH_FAILED' : 'WEBDAV_UPSTREAM_ERROR'
    });
  }
  return response;
}

export async function probeWebDav(session) {
  const started = Date.now();
  const response = await davFetch(session, '/', { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY }, { allowedStatuses: [207] });
  return { status: response.status, latencyMs: Date.now() - started };
}

export async function listDirectory(session, path = '/') {
  const normalized = normalizeDavPath(path, { directory: true });
  const response = await davFetch(session, normalized, { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY }, { allowedStatuses: [207] });
  const xml = await response.text();
  return { path: normalized, items: parseMultiStatus(xml, session.baseUrl, normalized) };
}

async function ensureDirectory(session, directoryPath) {
  const normalized = normalizeDavPath(directoryPath, { directory: true });
  if (normalized === '/') return;
  const segments = normalized.split('/').filter(Boolean);
  let current = '/';
  for (const segment of segments) {
    current = `${current}${segment}/`;
    await davFetch(session, current, { method: 'MKCOL' }, { allowedStatuses: [201, 405] });
  }
}

export async function createDirectory(session, path) {
  const normalized = normalizeDavPath(path, { directory: true, allowRoot: false });
  const parent = normalized.split('/').filter(Boolean).slice(0, -1);
  if (parent.length) await ensureDirectory(session, `/${parent.join('/')}/`);
  const response = await davFetch(session, normalized, { method: 'MKCOL' }, { allowedStatuses: [201, 405] });
  return { path: normalized, created: response.status === 201 };
}

export async function deletePath(session, path) {
  const normalized = normalizeDavPath(path, { allowRoot: false, directory: String(path).endsWith('/') });
  const response = await davFetch(session, normalized, { method: 'DELETE' }, { allowedStatuses: [200, 202, 204, 404] });
  return { path: normalized, deleted: response.status !== 404 };
}

export async function uploadFile(session, path, bytes, options = {}) {
  const normalized = normalizeDavPath(path, { allowRoot: false });
  if (bytes.byteLength > MAX_DIRECT_BYTES) throw new InputError('直接上传单次最多 5 MiB，请使用分片上传', 'FILE_TOO_LARGE', 413);
  const parentSegments = normalized.split('/').filter(Boolean).slice(0, -1);
  if (parentSegments.length) await ensureDirectory(session, `/${parentSegments.join('/')}/`);
  const response = await davFetch(session, normalized, { method: 'PUT', headers: { 'Content-Type': options.contentType || 'application/octet-stream', 'Content-Length': String(bytes.byteLength) }, body: bytes }, { allowedStatuses: [200, 201, 204] });
  return { path: normalized, created: response.status === 201, size: bytes.byteLength };
}

export function initChunkUpload(env, session, input) {
  const path = normalizeDavPath(input.path, { allowRoot: false });
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) throw new InputError('文件大小无效');
  if (size > getMaxUploadBytes(env)) throw new InputError('文件超过服务端允许的最大上传大小', 'FILE_TOO_LARGE', 413);
  const chunkBytes = getChunkBytes(env);
  const totalChunks = Math.ceil(size / chunkBytes);
  const uploadId = crypto.randomUUID().replace(/-/g, '');
  return { path, size, chunkBytes, totalChunks, uploadId, contentType: input.contentType || 'application/octet-stream' };
}

export async function prepareChunkUpload(env, session, upload) {
  const tempDirectory = `${getTempRoot(env)}/${upload.uploadId}/`;
  await ensureDirectory(session, tempDirectory);
  return { ...upload, tempDirectory };
}

function validateUploadId(uploadId) {
  if (!/^[a-f0-9]{32}$/i.test(String(uploadId || ''))) throw new InputError('uploadId 无效');
  return String(uploadId);
}

export async function uploadChunk(env, session, uploadId, index, bytes) {
  const id = validateUploadId(uploadId);
  const chunkBytes = getChunkBytes(env);
  const chunkIndex = Number(index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 999999) throw new InputError('分片 index 无效');
  if (!bytes.byteLength || bytes.byteLength > chunkBytes) throw new InputError(`单个分片必须在 1 ~ ${chunkBytes} bytes`, 'CHUNK_TOO_LARGE', 413);
  const path = `${getTempRoot(env)}/${id}/${String(chunkIndex).padStart(6, '0')}.part`;
  const response = await davFetch(session, path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) }, body: bytes }, { allowedStatuses: [200, 201, 204] });
  return { uploadId: id, index: chunkIndex, size: bytes.byteLength, stored: response.ok || [200, 201, 204].includes(response.status) };
}

function combinedChunkStream(env, session, uploadId, totalChunks) {
  const root = getTempRoot(env);
  let index = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      while (index < totalChunks) {
        if (!reader) {
          const chunkPath = `${root}/${uploadId}/${String(index).padStart(6, '0')}.part`;
          const response = await davFetch(session, chunkPath, { method: 'GET' });
          if (!response.body) throw new WebDavError(`分片 ${index} 没有响应体`, { code: 'CHUNK_READ_FAILED' });
          reader = response.body.getReader();
        }
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        reader = null;
        index += 1;
      }
      controller.close();
    },
    async cancel() { try { await reader?.cancel(); } catch {} }
  });
}

export async function completeChunkUpload(env, session, input) {
  const uploadId = validateUploadId(input.uploadId);
  const path = normalizeDavPath(input.path, { allowRoot: false });
  const totalChunks = Number(input.totalChunks);
  const size = Number(input.size);
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 1000000) throw new InputError('totalChunks 无效');
  if (!Number.isFinite(size) || size <= 0 || size > getMaxUploadBytes(env)) throw new InputError('文件大小无效');
  const parentSegments = path.split('/').filter(Boolean).slice(0, -1);
  if (parentSegments.length) await ensureDirectory(session, `/${parentSegments.join('/')}/`);
  const stream = combinedChunkStream(env, session, uploadId, totalChunks);
  const headers = authHeaders(session, { 'Content-Type': input.contentType || 'application/octet-stream', 'Content-Length': String(size) });
  const response = await fetch(buildDavUrl(session.baseUrl, path), { method: 'PUT', headers, body: stream, duplex: 'half' });
  if (![200, 201, 204].includes(response.status)) {
    throw new WebDavError(`WebDAV 合并写入失败：HTTP ${response.status}`, { status: 502, upstreamStatus: response.status, code: 'MERGE_UPLOAD_FAILED' });
  }
  const tempDirectory = `${getTempRoot(env)}/${uploadId}/`;
  try { await davFetch(session, tempDirectory, { method: 'DELETE' }, { allowedStatuses: [200, 202, 204, 404] }); } catch {}
  return { path, size, totalChunks, uploadId, created: response.status === 201 };
}

export async function cancelChunkUpload(env, session, uploadId) {
  const id = validateUploadId(uploadId);
  const tempDirectory = `${getTempRoot(env)}/${id}/`;
  const response = await davFetch(session, tempDirectory, { method: 'DELETE' }, { allowedStatuses: [200, 202, 204, 404] });
  return { uploadId: id, deleted: response.status !== 404 };
}

export async function statPath(session, path) {
  const normalized = normalizeDavPath(path, { allowRoot: false });
  const response = await davFetch(session, normalized, { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY }, { allowedStatuses: [207] });
  const xml = await response.text();
  const parsed = parseMultiStatus(xml, session.baseUrl, '/__not_the_same__/');
  const item = parsed.find((entry) => normalizeDavPath(entry.path, { directory: entry.type === 'directory' }) === normalized) || parsed[0];
  if (!item || item.type !== 'file') throw new InputError('目标不是可下载文件');
  return item;
}

export function downloadFilename(path) { return basename(normalizeDavPath(path, { allowRoot: false })); }
