import { corsPreflight, decodeBase64Bytes, handleApiError, json, readBinaryBody, readJson } from '../../../server/http.js';
import { MAX_DIRECT_BYTES } from '../../../server/config.js';
import { readWebDavSession, sessionTokenFromRequest } from '../../../server/session.js';
import { uploadFile } from '../../../server/webdav.js';

// v2.2 主协议：小文件也使用 JSON + Base64，避免 Makers 对原始二进制 body 的二次读取问题。
export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const bytes = decodeBase64Bytes(body.dataBase64, { maxBytes: MAX_DIRECT_BYTES });
    const result = await uploadFile(session, body.path, bytes, {
      contentType: body.contentType || 'application/octet-stream'
    });
    return json({ ok: true, ...result, transport: 'json-base64' }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return handleApiError(error, context);
  }
}

// 保留旧 PUT 兼容，但新 Demo 不再调用。
export async function onRequestPut(context) {
  try {
    const session = await readWebDavSession(sessionTokenFromRequest(context.request), context.env);
    const url = new URL(context.request.url);
    const path = url.searchParams.get('path') || '';
    const bytes = await readBinaryBody(context.request, { maxBytes: MAX_DIRECT_BYTES });
    const result = await uploadFile(session, path, bytes, {
      contentType: context.request.headers.get('content-type') || 'application/octet-stream'
    });
    return json({ ok: true, ...result, transport: 'raw-put-legacy' }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() { return corsPreflight(); }
