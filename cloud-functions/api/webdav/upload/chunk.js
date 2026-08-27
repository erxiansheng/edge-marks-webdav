import { corsPreflight, decodeBase64Bytes, handleApiError, json, readBinaryBody, readJson } from '../../../../server/http.js';
import { getChunkBytes } from '../../../../server/config.js';
import { readWebDavSession, sessionTokenFromRequest } from '../../../../server/session.js';
import { uploadChunk } from '../../../../server/webdav.js';

// v2.2 主协议：JSON + Base64。
// EdgeOne Makers 的 Node.js 适配层在部分场景会提前读取原始 PUT body；
// JSON 请求可以直接复用运行时已解析的 request.body，从源头避免二次消费。
export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const maxBytes = getChunkBytes(context.env);
    const bytes = decodeBase64Bytes(body.dataBase64, { maxBytes });
    const result = await uploadChunk(context.env, session, body.uploadId, body.index, bytes);
    return json({ ok: true, ...result, transport: 'json-base64' });
  } catch (error) {
    return handleApiError(error, context);
  }
}

// 兼容旧客户端的原始 PUT；新前端不再使用此入口。
export async function onRequestPut(context) {
  try {
    const session = await readWebDavSession(sessionTokenFromRequest(context.request), context.env);
    const url = new URL(context.request.url);
    const maxBytes = getChunkBytes(context.env);
    const bytes = await readBinaryBody(context.request, { maxBytes, code: 'CHUNK_TOO_LARGE' });
    const result = await uploadChunk(context.env, session, url.searchParams.get('uploadId'), url.searchParams.get('index'), bytes);
    return json({ ok: true, ...result, transport: 'raw-put-legacy' });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() { return corsPreflight(); }
