import { InputError } from '../../../../shared/webdav-common.js';
import { handleApiError, json, readJson } from '../../../../server/http.js';
import { readWebDavSession } from '../../../../server/session.js';
import { listDirectory } from '../../../../server/webdav.js';

function envValue(env, key, fallback = '') {
  const value = typeof env?.[key] === 'string' ? env[key].trim() : '';
  return value || fallback;
}

function requireInternalRequest(context) {
  const expected = envValue(context.env, 'WEBDAV_INTERNAL_KEY');
  if (expected.length < 24) {
    throw new InputError('WEBDAV_INTERNAL_KEY 至少需要 24 个字符', 'WEBDAV_INTERNAL_KEY_MISSING', 503);
  }
  const received = context.request.headers.get('x-webdav-internal-key') || '';
  if (received !== expected) {
    throw new InputError('仅允许项目内部 Edge Function 调用目录代理', 'INTERNAL_ORIGIN_FORBIDDEN', 403);
  }
}

export async function onRequestPost(context) {
  try {
    requireInternalRequest(context);
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const result = await listDirectory(session, body.path || '/');
    return json({ ok: true, ...result, webdavOrigin: 'makers-cloud-function' });
  } catch (error) {
    return handleApiError(error, context);
  }
}
