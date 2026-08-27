import { getWebDavCredentials } from '../../../server/config.js';
import { corsPreflight, handleApiError, json } from '../../../server/http.js';
import { createWebDavSession } from '../../../server/session.js';
import { probeWebDav } from '../../../server/webdav.js';

function maskUsername(username) {
  if (username.length <= 4) return `${username.slice(0, 1)}***`;
  return `${username.slice(0, 2)}***${username.slice(-2)}`;
}

export async function onRequestPost(context) {
  try {
    const credentials = getWebDavCredentials(context.env);
    const probe = await probeWebDav(credentials);
    const session = await createWebDavSession(context.env);
    return json({
      ok: true,
      session,
      connection: {
        baseUrl: credentials.baseUrl,
        username: maskUsername(credentials.username),
        source: 'environment',
        probe
      }
    });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() { return corsPreflight(); }
