import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getCdnOriginKey, getCdnRangeBytes, getWebDavCredentials } from '../../server/config.js';
import { applyCorsHeaders, corsPreflight, encodeContentDisposition, handleApiError } from '../../server/http.js';
import { davFetch, downloadFilename, statPath } from '../../server/webdav.js';
import { InputError, normalizeDavPath, WebDavError } from '../../shared/webdav-common.js';

const VERSION_RE = /^[a-f0-9]{64}$/;

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function requireCdnOrigin(request, env) {
  const expected = getCdnOriginKey(env);
  const actual = request.headers.get('x-cdn-origin-key') || '';
  if (!secureEqual(actual, expected)) {
    throw new InputError('该下载源站仅允许 EdgeOne CDN 回源访问', 'CDN_ORIGIN_FORBIDDEN', 403);
  }
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); } catch { throw new InputError('下载路径 URL 编码错误'); }
}

export function parseDownloadPath(requestUrl) {
  const pathname = new URL(requestUrl).pathname;
  const prefix = '/download/';
  if (!pathname.startsWith(prefix)) throw new InputError('下载路径无效');
  const parts = pathname.slice(prefix.length).split('/').filter(Boolean);
  const version = parts.shift() || '';
  if (!VERSION_RE.test(version)) throw new InputError('下载版本号无效');
  if (!parts.length) throw new InputError('缺少下载文件路径');
  const path = normalizeDavPath(`/${parts.map(decodeSegment).join('/')}`, { allowRoot: false });
  return { version, path };
}

export function parseSingleRange(value, maxBytes) {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(value).trim());
  if (!match) throw new InputError('仅支持单段明确起止位置的 Range 请求', 'INVALID_RANGE', 416);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new InputError('Range 范围无效', 'INVALID_RANGE', 416);
  }
  const length = end - start + 1;
  if (length > maxBytes) {
    throw new InputError(`单次 Range 最大允许 ${maxBytes} bytes`, 'RANGE_TOO_LARGE', 416);
  }
  return { start, end, length, header: `bytes=${start}-${end}` };
}

function contentRangeLength(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start ? end - start + 1 : null;
}

function responseHeaders(upstream, filename) {
  const headers = applyCorsHeaders(new Headers());
  const passthrough = [
    'Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges',
    'ETag', 'Last-Modified', 'Content-Encoding'
  ];
  for (const name of passthrough) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Disposition', encodeContentDisposition(filename));
  headers.set('Cache-Control', 'public, max-age=2592000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

async function handleHead(context, credentials, path) {
  const stat = await statPath(credentials, path);
  const headers = applyCorsHeaders(new Headers());
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Disposition', encodeContentDisposition(downloadFilename(path)));
  headers.set('Cache-Control', 'public, max-age=2592000, immutable');
  if (stat.size != null) headers.set('Content-Length', String(stat.size));
  if (stat.contentType) headers.set('Content-Type', stat.contentType);
  if (stat.etag) headers.set('ETag', stat.etag);
  if (stat.modified) headers.set('Last-Modified', stat.modified);
  return new Response(null, { status: 200, headers });
}

async function handleGet(context, credentials, path) {
  const maxRangeBytes = getCdnRangeBytes(context.env);
  const range = parseSingleRange(context.request.headers.get('range'), maxRangeBytes);

  if (!range) {
    // EdgeOne 开启分片回源后，大文件 MISS 应携带 Range 到这里。
    // 仅允许 <= 4 MiB 的小文件无 Range 回源，避免 Cloud Function 6 MB 响应限制。
    const stat = await statPath(credentials, path);
    if (stat.size == null || stat.size > maxRangeBytes) {
      throw new InputError(
        `大文件下载必须通过 Range 回源；当前单次最大 ${maxRangeBytes} bytes。请确认 EdgeOne /download/* 已开启分片回源。`,
        'RANGE_REQUIRED',
        416
      );
    }
  }

  const headers = new Headers();
  if (range) headers.set('Range', range.header);
  for (const name of ['if-range', 'if-none-match', 'if-modified-since']) {
    const value = context.request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await davFetch(credentials, path, { method: 'GET', headers });
  if (range && upstream.status !== 206) {
    try { await upstream.body?.cancel(); } catch {}
    throw new WebDavError('WebDAV 未按 Range 返回 206，无法安全代理大文件', {
      status: 502,
      upstreamStatus: upstream.status,
      code: 'WEBDAV_RANGE_UNSUPPORTED'
    });
  }

  const contentLength = Number(upstream.headers.get('content-length'));
  const rangeLength = contentRangeLength(upstream.headers.get('content-range'));
  const actualLength = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : rangeLength;
  if (actualLength != null && actualLength > maxRangeBytes) {
    try { await upstream.body?.cancel(); } catch {}
    throw new WebDavError('WebDAV 返回的 Range 数据超过 Cloud Function 安全上限', {
      status: 502,
      upstreamStatus: upstream.status,
      code: 'WEBDAV_RANGE_TOO_LARGE'
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream, downloadFilename(path))
  });
}

async function handleRequest(context) {
  requireCdnOrigin(context.request, context.env);
  const credentials = getWebDavCredentials(context.env);
  const { path } = parseDownloadPath(context.request.url);
  if (context.request.method === 'HEAD') return handleHead(context, credentials, path);
  return handleGet(context, credentials, path);
}

export async function onRequestGet(context) {
  try { return await handleRequest(context); } catch (error) { return handleApiError(error, context); }
}

export async function onRequestHead(context) {
  try { return await handleRequest(context); } catch (error) { return handleApiError(error, context); }
}

export function onRequestOptions() {
  return corsPreflight();
}
