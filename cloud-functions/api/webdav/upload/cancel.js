import { corsPreflight, handleApiError, json, readJson } from '../../../../server/http.js';
import { readWebDavSession } from '../../../../server/session.js';
import { cancelChunkUpload } from '../../../../server/webdav.js';

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const result = await cancelChunkUpload(context.env, session, body.uploadId);
    return json({ ok: true, ...result });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() { return corsPreflight(); }
