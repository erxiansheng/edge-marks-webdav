import { sha256Hex } from '../../../../shared/codec.js';
import { openToken } from '../../../../shared/session.js';
import { normalizeDavPath } from '../../../../shared/webdav-common.js';

function envValue(context, key, fallback = '') {
  return (context.env && typeof context.env[key] === 'string' ? context.env[key].trim() : '') || fallback;
}

function kvBinding(context) {
  const fromEnv = context.env?.WEBDAV_KV;
  if (fromEnv && typeof fromEnv.delete === 'function') return fromEnv;
  if (typeof WEBDAV_KV !== 'undefined' && WEBDAV_KV && typeof WEBDAV_KV.delete === 'function') return WEBDAV_KV;
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function parent(path) {
  const parts = normalizeDavPath(path, { directory: true }).split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}/` : '/';
}

async function keyFor(context, path) {
  const baseUrl = envValue(context, 'WEBDAV_BASE_URL', 'configured-webdav');
  const username = envValue(context, 'WEBDAV_USERNAME', 'configured-user');
  return `list_${await sha256Hex(`${baseUrl}\u0000${username}\u0000${path}`)}`;
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const secret = envValue(context, 'WEBDAV_SESSION_SECRET');
    await openToken(body.session, secret, 'webdav-session');
    const kv = kvBinding(context);
    if (!kv) return json({ ok: true, cache: 'bypass' });

    const paths = new Set((Array.isArray(body.paths) ? body.paths : [body.path || '/']).flatMap((value) => {
      const normalized = normalizeDavPath(value || '/', { directory: String(value || '/').endsWith('/') });
      return [normalized.endsWith('/') ? normalized : parent(normalized), parent(normalized)];
    }));

    for (const path of paths) await kv.delete(await keyFor(context, path));
    return json({ ok: true, deleted: paths.size });
  } catch (error) {
    return json({ ok: false, error: { message: error?.message || '缓存失效失败' } }, 400);
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
