import { corsPreflight, handleApiError, json, readJson } from '../../../server/http.js';
import { readWebDavSession } from '../../../server/session.js';
import { createDirectory } from '../../../server/webdav.js';

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const result = await createDirectory(session, body.path);
    return json({ ok: true, ...result }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() { return corsPreflight(); }
