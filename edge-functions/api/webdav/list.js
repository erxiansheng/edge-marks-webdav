import { sha256Hex } from '../../../shared/codec.js';
import { openToken } from '../../../shared/session.js';
import { authHeaders, buildDavUrl, normalizeBaseUrl, normalizeDavPath, parseMultiStatus, PROPFIND_BODY } from '../../../shared/webdav-common.js';

function envValue(context, key, fallback = '') {
  const value = context.env && typeof context.env[key] === 'string' ? context.env[key].trim() : '';
  return value || fallback;
}
function configuredSession(context) {
  const rawBaseUrl = envValue(context, 'WEBDAV_BASE_URL');
  const username = envValue(context, 'WEBDAV_USERNAME');
  const password = envValue(context, 'WEBDAV_PASSWORD');
  if (!rawBaseUrl || !username || !password) throw new Error('缺少 WEBDAV_BASE_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD');
  let allow = envValue(context, 'WEBDAV_ALLOWED_HOSTS').split(',').map((item) => item.trim()).filter(Boolean);
  if (!allow.length) {
    try { allow = [new URL(rawBaseUrl).hostname]; } catch {}
  }
  return { baseUrl: normalizeBaseUrl(rawBaseUrl, allow), username, password };
}
function kvBinding(context) {
  const fromEnv = context.env?.WEBDAV_KV;
  if (fromEnv && typeof fromEnv.get === 'function') return fromEnv;
  if (typeof WEBDAV_KV !== 'undefined' && WEBDAV_KV && typeof WEBDAV_KV.get === 'function') return WEBDAV_KV;
  return null;
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
  });
}
async function validateSession(context, token) {
  const secret = envValue(context, 'WEBDAV_SESSION_SECRET');
  if (!secret) throw new Error('缺少 WEBDAV_SESSION_SECRET');
  await openToken(token, secret, 'webdav-session');
  return configuredSession(context);
}
async function cacheKey(session, path) {
  return `list_${await sha256Hex(`${session.baseUrl}\u0000${session.username}\u0000${path}`)}`;
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const session = await validateSession(context, body.session);
    const path = normalizeDavPath(body.path || '/', { directory: true });
    const kv = kvBinding(context);
    const key = await cacheKey(session, path);
    const now = Date.now();
    if (kv) {
      const cached = await kv.get(key, { type: 'json' });
      if (cached && cached.expiresAt > now && cached.payload) {
        return json({ ok: true, ...cached.payload, cache: { layer: 'kv', hit: true } }, 200, { 'X-KV-Cache': 'HIT' });
      }
    }

    const headers = authHeaders(session, { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' });
    const response = await fetch(buildDavUrl(session.baseUrl, path), { method: 'PROPFIND', headers, body: PROPFIND_BODY });
    if (response.status === 401 || response.status === 403) return json({ ok: false, error: { code: 'WEBDAV_AUTH_FAILED', message: 'WebDAV 鉴权失败' } }, 401);
    if (response.status !== 207 && !response.ok) return json({ ok: false, error: { code: 'WEBDAV_UPSTREAM_ERROR', message: `WebDAV 返回 HTTP ${response.status}` } }, 502);
    const xml = await response.text();
    const payload = { path, items: parseMultiStatus(xml, session.baseUrl, path) };
    if (kv) {
      const ttl = Math.max(3000, Math.min(Number(envValue(context, 'DIRECTORY_CACHE_TTL_MS', '15000')) || 15000, 120000));
      context.waitUntil(kv.put(key, JSON.stringify({ expiresAt: now + ttl, payload })));
    }
    return json({ ok: true, ...payload, cache: { layer: kv ? 'kv' : 'none', hit: false } }, 200, { 'X-KV-Cache': kv ? 'MISS' : 'BYPASS' });
  } catch (error) {
    return json({ ok: false, error: { code: 'LIST_FAILED', message: error?.message || '目录读取失败' } }, /令牌|会话/.test(error?.message || '') ? 401 : 400);
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
}
