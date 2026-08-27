import { sha256Hex } from '../../../shared/codec.js';
import { openToken } from '../../../shared/session.js';
import { normalizeDavPath } from '../../../shared/webdav-common.js';

function envValue(context, key, fallback = '') {
  const value = context.env && typeof context.env[key] === 'string' ? context.env[key].trim() : '';
  return value || fallback;
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra
    }
  });
}

async function validateSession(context, token) {
  const secret = envValue(context, 'WEBDAV_SESSION_SECRET');
  if (!secret) throw new Error('缺少 WEBDAV_SESSION_SECRET');
  await openToken(token, secret, 'webdav-session');
}

async function cacheKey(context, path) {
  // Edge Function 不再访问 WebDAV；这里只用非密码配置生成缓存命名空间。
  // baseUrl / username 变化时自动切换到新的缓存 key，避免旧目录短暂串用。
  const baseUrl = envValue(context, 'WEBDAV_BASE_URL', 'configured-webdav');
  const username = envValue(context, 'WEBDAV_USERNAME', 'configured-user');
  return `list_${await sha256Hex(`${baseUrl}\u0000${username}\u0000${path}`)}`;
}

function internalKey(context) {
  const key = envValue(context, 'WEBDAV_INTERNAL_KEY');
  if (key.length < 24) throw new Error('WEBDAV_INTERNAL_KEY 至少需要 24 个字符');
  return key;
}

async function listThroughCloudFunction(context, sessionToken, path) {
  const url = new URL('/api/internal/webdav/list', context.request.url);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-WebDAV-Internal-Key': internalKey(context)
    },
    body: JSON.stringify({ session: sessionToken, path })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloud Function 目录代理返回非 JSON 响应（HTTP ${response.status}）`);
  }

  if (!response.ok || !payload?.ok) {
    const message = payload?.error?.message || `Cloud Function 目录代理返回 HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return { path: payload.path, items: payload.items };
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    await validateSession(context, body.session);
    const path = normalizeDavPath(body.path || '/', { directory: true });
    const kv = kvBinding(context);
    const key = await cacheKey(context, path);
    const now = Date.now();

    if (kv) {
      const cached = await kv.get(key, { type: 'json' });
      if (cached && cached.expiresAt > now && cached.payload) {
        return json(
          { ok: true, ...cached.payload, cache: { layer: 'kv', hit: true, webdavOrigin: 'none' } },
          200,
          { 'X-KV-Cache': 'HIT', 'X-WebDAV-Origin': 'NONE' }
        );
      }
    }

    // KV MISS 时绝不从 Edge Function 直连 WebDAV。
    // 统一调用 Makers Cloud Function，由 Cloud Function 发出 PROPFIND 到 WebDAV。
    const payload = await listThroughCloudFunction(context, body.session, path);

    if (kv) {
      const ttl = Math.max(3000, Math.min(Number(envValue(context, 'DIRECTORY_CACHE_TTL_MS', '15000')) || 15000, 120000));
      const write = kv.put(key, JSON.stringify({ expiresAt: now + ttl, payload }));
      if (typeof context.waitUntil === 'function') context.waitUntil(write);
      else await write;
    }

    return json(
      {
        ok: true,
        ...payload,
        cache: { layer: kv ? 'kv' : 'none', hit: false, webdavOrigin: 'makers-cloud-function' }
      },
      200,
      { 'X-KV-Cache': kv ? 'MISS' : 'BYPASS', 'X-WebDAV-Origin': 'CLOUD-FUNCTION' }
    );
  } catch (error) {
    if (error?.payload && Number.isInteger(error?.status)) {
      return json(error.payload, error.status, { 'X-WebDAV-Origin': 'CLOUD-FUNCTION' });
    }
    const message = error?.message || '目录读取失败';
    const sessionError = /令牌|会话/.test(message);
    const configError = /WEBDAV_INTERNAL_KEY/.test(message);
    return json(
      { ok: false, error: { code: configError ? 'INTERNAL_KEY_INVALID' : 'LIST_FAILED', message } },
      configError ? 503 : sessionError ? 401 : 400
    );
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
