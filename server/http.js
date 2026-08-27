import { Buffer } from 'node:buffer';
import { InputError, WebDavError } from '../shared/webdav-common.js';

const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'X-WebDAV-Session, Content-Type, Accept, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition, Content-Type, ETag, Last-Modified, Accept-Ranges, Content-Range, X-KV-Cache',
  'Access-Control-Max-Age': '86400'
});

export function applyCorsHeaders(headers) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return headers;
}
export function corsPreflight() {
  const headers = applyCorsHeaders(new Headers());
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(null, { status: 204, headers });
}
export function json(data, options = {}) {
  const headers = applyCorsHeaders(new Headers(options.headers || {}));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(data, null, 2), { status: options.status || 200, headers });
}

function isReadableStreamLike(value) {
  return Boolean(value && typeof value === 'object' && typeof value.getReader === 'function');
}

function decodeParsedJsonBody(body) {
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(body));
  if (ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body));
  if (body && typeof body === 'object' && !isReadableStreamLike(body)) return body;
  return null;
}

export async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) throw new InputError('请求体必须是 application/json');

  // Makers 的部分 Node.js 运行时/适配层可能会提前解析请求体。
  // 如果 request.body 已经是对象、字符串或 Buffer/TypedArray，就直接使用，
  // 避免再次调用 request.json() 触发 "Body has already been read"。
  const parsedBody = decodeParsedJsonBody(request.body);
  if (parsedBody !== null) return parsedBody;

  if (request.bodyUsed) {
    throw new InputError('请求体已被 Makers 运行时读取，无法再次解析', 'REQUEST_BODY_ALREADY_READ', 400);
  }

  try {
    return await request.json();
  } catch {
    throw new InputError('JSON 请求体格式错误');
  }
}

export function decodeBase64Bytes(value, options = {}) {
  if (typeof value !== 'string' || !value) throw new InputError('缺少分片 dataBase64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new InputError('dataBase64 格式错误');
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    throw new InputError('dataBase64 解码失败');
  }
  if (!bytes.byteLength) throw new InputError('分片内容不能为空');
  if (options.maxBytes && bytes.byteLength > options.maxBytes) {
    throw new InputError(`分片超过允许大小 ${options.maxBytes} bytes`, 'CHUNK_TOO_LARGE', 413);
  }
  return bytes;
}

export async function readBinaryBody(request, options = {}) {
  const body = request.body;
  let bytes = null;

  // 兼容 Makers 运行时已提前读取并挂到 request.body 的二进制实体。
  if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  else if (typeof body === 'string') bytes = new TextEncoder().encode(body);

  if (!bytes) {
    if (request.bodyUsed) {
      throw new InputError('二进制请求体已被 Makers 运行时读取，请升级前端使用 JSON Base64 上传协议', 'REQUEST_BODY_ALREADY_READ', 400);
    }
    try {
      bytes = new Uint8Array(await request.arrayBuffer());
    } catch (error) {
      if (/already been read|body is unusable/i.test(String(error?.message || ''))) {
        throw new InputError('二进制请求体已被 Makers 运行时读取，请升级前端使用 JSON Base64 上传协议', 'REQUEST_BODY_ALREADY_READ', 400);
      }
      throw error;
    }
  }

  if (!bytes.byteLength) throw new InputError('请求体不能为空');
  if (options.maxBytes && bytes.byteLength > options.maxBytes) {
    throw new InputError(`请求体超过允许大小 ${options.maxBytes} bytes`, options.code || 'FILE_TOO_LARGE', 413);
  }
  return bytes;
}

export function handleApiError(error, context = {}) {
  const requestId = context.requestId || context?.server?.requestId || null;
  const status = error instanceof InputError ? error.status : error instanceof WebDavError ? error.status : /会话|令牌/.test(error?.message || '') ? 401 : 500;
  const code = error instanceof InputError ? error.code : error instanceof WebDavError ? error.code : status === 401 ? 'SESSION_INVALID' : 'INTERNAL_ERROR';
  if (status === 500) console.error('Unexpected API error', { name: error?.name, message: error?.message, stack: error?.stack, requestId });
  return json({ ok: false, error: { code, message: status === 500 ? '函数内部错误' : error.message, upstreamStatus: error?.upstreamStatus ?? null, requestId } }, { status });
}
export function encodeContentDisposition(filename) {
  const asciiFallback = String(filename || 'download').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename || 'download')}`;
}
