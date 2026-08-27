import { openToken, sealToken } from '../shared/session.js';
import { getSessionSecret, getSessionTtlSeconds, getWebDavCredentials } from './config.js';

export async function createWebDavSession(env = {}) {
  return sealToken({ kind: 'webdav-session', scope: 'configured-webdav' }, getSessionSecret(env), getSessionTtlSeconds(env));
}

export async function readWebDavSession(token, env = {}) {
  await openToken(token, getSessionSecret(env), 'webdav-session');
  return getWebDavCredentials(env);
}

export function sessionTokenFromRequest(request) {
  return request.headers.get('x-webdav-session') || '';
}
