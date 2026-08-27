import { basicAuthorization } from './codec.js';

export class InputError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.status = status;
  }
}

export class WebDavError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WebDavError';
    this.status = options.status ?? 502;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.code = options.code ?? 'WEBDAV_ERROR';
  }
}

function isPrivateIpv4(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some((part) => part < 0 || part > 255)) return true;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
}

function hostAllowed(hostname, allowlist) {
  if (!allowlist?.length) return true;
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule.startsWith('*.')) return host === rule.slice(2) || host.endsWith(rule.slice(1));
    return host === rule;
  });
}

export function normalizeBaseUrl(input, allowlist = []) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new InputError('WebDAV 地址格式错误');
  }
  if (url.protocol !== 'https:') throw new InputError('WebDAV 地址必须使用 HTTPS');
  if (url.username || url.password) throw new InputError('请不要把账号密码写进 WebDAV URL');
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new InputError('出于 SSRF 安全限制，不允许访问本机或私网 WebDAV 地址', 'PRIVATE_ORIGIN_BLOCKED', 403);
  }
  if (!hostAllowed(hostname, allowlist)) {
    throw new InputError('该 WebDAV 主机不在 WEBDAV_ALLOWED_HOSTS 白名单中', 'ORIGIN_NOT_ALLOWED', 403);
  }
  return url.toString().replace(/\/+$/, '');
}

export function normalizeDavPath(input, options = {}) {
  const directory = options.directory === true;
  const allowRoot = options.allowRoot !== false;
  if (typeof input !== 'string') throw new InputError('path 必须是字符串');
  const value = input.trim().replace(/\\/g, '/');
  if (!value || value === '/') {
    if (!allowRoot) throw new InputError('根目录不能执行此操作');
    return '/';
  }
  if (value.includes('\u0000') || /[\u0000-\u001f]/.test(value)) throw new InputError('path 包含非法控制字符');
  if (value.includes('://')) throw new InputError('path 只能是 WebDAV 内部路径');
  const segments = value.split('/').filter((segment) => segment && segment !== '.');
  if (segments.some((segment) => segment === '..')) throw new InputError('path 不允许包含 ..');
  let normalized = `/${segments.join('/')}`;
  if (directory && normalized !== '/' && !normalized.endsWith('/')) normalized += '/';
  if (!directory && normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

export function buildDavUrl(baseUrl, path) {
  const isDirectory = typeof path === 'string' && path.trim().endsWith('/');
  const normalized = normalizeDavPath(path, { directory: isDirectory });
  const encoded = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${baseUrl.replace(/\/+$/, '')}${encoded === '/' ? '/' : encoded}`;
}

export function authHeaders(session, headers = {}) {
  const result = new Headers(headers);
  result.set('Authorization', basicAuthorization(session.username, session.password));
  return result;
}

export function basename(path) {
  if (path === '/') return '/';
  const clean = path.replace(/\/+$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function decodeXml(value = '') {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function stripTags(value = '') { return decodeXml(value.replace(/<[^>]*>/g, '')).trim(); }
function extractTag(block, tagName) {
  const expression = new RegExp(`<(?:[\\w.-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tagName}>`, 'i');
  const match = block.match(expression);
  return match ? match[1] : '';
}
function safeDecodeURIComponent(input) { try { return decodeURIComponent(input); } catch { return input; } }
function selectSuccessfulPropstat(block) {
  const pattern = /<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat>/gi;
  let fallback = '';
  let match;
  while ((match = pattern.exec(block)) !== null) {
    const propstat = match[1];
    if (!fallback) fallback = propstat;
    const status = stripTags(extractTag(propstat, 'status'));
    if (/\s2\d\d(?:\s|$)/.test(status)) return propstat;
  }
  return fallback || block;
}
function pathFromHref(href, baseUrl) {
  const base = new URL(baseUrl);
  const target = new URL(decodeXml(href), `${baseUrl.replace(/\/+$/, '')}/`);
  const basePath = base.pathname.replace(/\/+$/, '');
  let pathname = safeDecodeURIComponent(target.pathname);
  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) pathname = pathname.slice(basePath.length);
  return normalizeDavPath(pathname || '/', { directory: pathname.endsWith('/') });
}

export function parseMultiStatus(xml, baseUrl, requestedPath = '/') {
  const responses = [];
  const responsePattern = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  let match;
  while ((match = responsePattern.exec(xml)) !== null) {
    const block = match[1];
    const href = stripTags(extractTag(block, 'href'));
    if (!href) continue;
    const propertyBlock = selectSuccessfulPropstat(block);
    const resourceType = extractTag(propertyBlock, 'resourcetype');
    const isDirectory = /<(?:[\w.-]+:)?collection\b/i.test(resourceType);
    let path;
    try { path = pathFromHref(href, baseUrl); } catch { continue; }
    if (isDirectory && path !== '/' && !path.endsWith('/')) path += '/';
    const displayName = stripTags(extractTag(propertyBlock, 'displayname')) || basename(path);
    const sizeText = stripTags(extractTag(propertyBlock, 'getcontentlength'));
    responses.push({
      name: displayName,
      path,
      type: isDirectory ? 'directory' : 'file',
      size: isDirectory || sizeText === '' || !Number.isFinite(Number(sizeText)) ? null : Number(sizeText),
      modified: stripTags(extractTag(propertyBlock, 'getlastmodified')) || null,
      contentType: stripTags(extractTag(propertyBlock, 'getcontenttype')) || null,
      etag: stripTags(extractTag(propertyBlock, 'getetag')) || null
    });
  }
  const normalizedRequested = normalizeDavPath(requestedPath, { directory: true });
  return responses
    .filter((item) => normalizeDavPath(item.path, { directory: item.type === 'directory' }) !== normalizedRequested)
    .sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

export const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:getetag/></d:prop></d:propfind>`;
