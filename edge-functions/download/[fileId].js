import { openToken } from '../../shared/session.js';
import { authHeaders, buildDavUrl, normalizeBaseUrl } from '../../shared/webdav-common.js';

function envValue(context, key, fallback = '') { return (context.env && typeof context.env[key] === 'string' ? context.env[key].trim() : '') || fallback; }
function configuredSession(context) {
  const rawBaseUrl = envValue(context, 'WEBDAV_BASE_URL');
  const username = envValue(context, 'WEBDAV_USERNAME');
  const password = envValue(context, 'WEBDAV_PASSWORD');
  if (!rawBaseUrl || !username || !password) throw new Error('missing WebDAV environment configuration');
  let allow = envValue(context, 'WEBDAV_ALLOWED_HOSTS').split(',').map((item) => item.trim()).filter(Boolean);
  if (!allow.length) {
    try { allow = [new URL(rawBaseUrl).hostname]; } catch {}
  }
  return { baseUrl: normalizeBaseUrl(rawBaseUrl, allow), username, password };
}
function errorResponse(message, status = 403) { return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
function contentDisposition(filename) {
  const fallback = String(filename || 'download').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename || 'download')}`;
}

async function handle(context, method) {
  try {
    const requestUrl = new URL(context.request.url);
    const ticket = requestUrl.searchParams.get('ticket');
    if (!ticket) return errorResponse('missing ticket', 401);
    const payload = await openToken(ticket, envValue(context, 'WEBDAV_SESSION_SECRET'), 'download-ticket');
    const fileId = String(context.params?.fileId || '');
    if (!fileId || payload.fileId !== fileId) return errorResponse('ticket/file mismatch', 403);
    const session = configuredSession(context);
    const headers = authHeaders(session);
    for (const name of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
      const value = context.request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(buildDavUrl(session.baseUrl, payload.path), { method, headers, redirect: 'follow' });
    if (![200, 206, 304].includes(upstream.status)) {
      if (upstream.status === 401 || upstream.status === 403) return errorResponse('WebDAV authentication failed', 401);
      return errorResponse(`WebDAV upstream HTTP ${upstream.status}`, 502);
    }
    const responseHeaders = new Headers();
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/octet-stream');
    responseHeaders.set('Content-Disposition', contentDisposition(payload.filename));
    responseHeaders.set('Cache-Control', 'public, s-maxage=2592000, max-age=0');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    return errorResponse(error?.message || 'download gateway error', /会话|令牌/.test(error?.message || '') ? 401 : 500);
  }
}

export function onRequestGet(context) { return handle(context, 'GET'); }
export function onRequestHead(context) { return handle(context, 'HEAD'); }
