import { sha256Hex } from '../../../../shared/codec.js';
import { openToken } from '../../../../shared/session.js';
import { normalizeBaseUrl, normalizeDavPath } from '../../../../shared/webdav-common.js';

function envValue(context, key, fallback = '') { return (context.env && typeof context.env[key] === 'string' ? context.env[key].trim() : '') || fallback; }
function configuredSession(context) {
  const rawBaseUrl = envValue(context, 'WEBDAV_BASE_URL');
  const username = envValue(context, 'WEBDAV_USERNAME');
  const password = envValue(context, 'WEBDAV_PASSWORD');
  if (!rawBaseUrl || !username || !password) throw new Error('缺少 WebDAV 环境变量');
  let allow = envValue(context, 'WEBDAV_ALLOWED_HOSTS').split(',').map((value) => value.trim()).filter(Boolean);
  if (!allow.length) {
    try { allow = [new URL(rawBaseUrl).hostname]; } catch {}
  }
  return { baseUrl: normalizeBaseUrl(rawBaseUrl, allow), username, password };
}
function kvBinding(context) { const fromEnv = context.env?.WEBDAV_KV; if (fromEnv && typeof fromEnv.delete === 'function') return fromEnv; if (typeof WEBDAV_KV !== 'undefined' && WEBDAV_KV && typeof WEBDAV_KV.delete === 'function') return WEBDAV_KV; return null; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
function parent(path) { const parts = normalizeDavPath(path, { directory: true }).split('/').filter(Boolean); parts.pop(); return parts.length ? `/${parts.join('/')}/` : '/'; }
async function keyFor(session, path) { return `list_${await sha256Hex(`${session.baseUrl}\u0000${session.username}\u0000${path}`)}`; }

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const secret = envValue(context, 'WEBDAV_SESSION_SECRET');
    await openToken(body.session, secret, 'webdav-session');
    const session = configuredSession(context);
    const kv = kvBinding(context);
    if (!kv) return json({ ok: true, cache: 'bypass' });
    const paths = new Set((Array.isArray(body.paths) ? body.paths : [body.path || '/']).flatMap((value) => {
      const normalized = normalizeDavPath(value || '/', { directory: String(value || '/').endsWith('/') });
      return [normalized.endsWith('/') ? normalized : parent(normalized), parent(normalized)];
    }));
    for (const path of paths) await kv.delete(await keyFor(session, path));
    return json({ ok: true, deleted: paths.size });
  } catch (error) {
    return json({ ok: false, error: { message: error?.message || '缓存失效失败' } }, 400);
  }
}

export function onRequestOptions() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } }); }
