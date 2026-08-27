import { corsPreflight, handleApiError, json, readJson } from '../../../../server/http.js';
import { readWebDavSession } from '../../../../server/session.js';
import { initChunkUpload, prepareChunkUpload } from '../../../../server/webdav.js';

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const upload = initChunkUpload(context.env, session, body);
    const result = await prepareChunkUpload(context.env, session, upload);
    return json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() { return corsPreflight(); }
