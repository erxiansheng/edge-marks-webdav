import { InputError, normalizeBaseUrl } from '../shared/webdav-common.js';

export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
// JSON Base64 传输会膨胀约 4/3；4 MiB 二进制编码后约 5.34 MiB，安全低于 Cloud Function 6 MB Body 上限。
export const MAX_DIRECT_BYTES = 4 * 1024 * 1024;

export function pick(env, key, fallback = '') {
  const fromContext = env && typeof env[key] === 'string' ? env[key].trim() : '';
  const fromProcess = typeof process !== 'undefined' && typeof process.env?.[key] === 'string' ? process.env[key].trim() : '';
  return fromContext || fromProcess || fallback;
}

export function getAllowedHosts(env = {}) {
  return pick(env, 'WEBDAV_ALLOWED_HOSTS').split(',').map((item) => item.trim()).filter(Boolean);
}

export function getWebDavCredentials(env = {}) {
  const rawBaseUrl = pick(env, 'WEBDAV_BASE_URL');
  const username = pick(env, 'WEBDAV_USERNAME');
  const password = pick(env, 'WEBDAV_PASSWORD');
  const missing = [];
  if (!rawBaseUrl) missing.push('WEBDAV_BASE_URL');
  if (!username) missing.push('WEBDAV_USERNAME');
  if (!password) missing.push('WEBDAV_PASSWORD');
  if (missing.length) throw new Error(`缺少必填环境变量：${missing.join(', ')}`);

  let allowlist = getAllowedHosts(env);
  if (!allowlist.length) {
    try { allowlist = [new URL(rawBaseUrl).hostname]; } catch {}
  }

  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl, allowlist),
    username,
    password
  };
}

export function getSessionSecret(env = {}) {
  const value = pick(env, 'WEBDAV_SESSION_SECRET');
  if (!value || value.length < 24) throw new Error('缺少 WEBDAV_SESSION_SECRET，且长度至少需要 24 个字符');
  return value;
}

export function getSessionTtlSeconds(env = {}) {
  const value = Number(pick(env, 'WEBDAV_SESSION_TTL_SECONDS', String(12 * 60 * 60)));
  return Number.isFinite(value) ? Math.max(300, Math.min(value, 7 * 24 * 60 * 60)) : 12 * 60 * 60;
}

export function getChunkBytes(env = {}) {
  const value = Number(pick(env, 'WEBDAV_CHUNK_BYTES', String(DEFAULT_CHUNK_BYTES)));
  return Number.isFinite(value) ? Math.max(1024 * 1024, Math.min(value, DEFAULT_CHUNK_BYTES)) : DEFAULT_CHUNK_BYTES;
}

export function getMaxUploadBytes(env = {}) {
  const value = Number(pick(env, 'WEBDAV_MAX_UPLOAD_BYTES', String(8 * 1024 * 1024 * 1024)));
  return Number.isFinite(value) ? Math.max(MAX_DIRECT_BYTES, value) : 8 * 1024 * 1024 * 1024;
}

export function getTempRoot(env = {}) {
  const root = pick(env, 'WEBDAV_TEMP_DIR', '/.edgeone-upload').replace(/\\/g, '/');
  return root.startsWith('/') ? root.replace(/\/+$/, '') : `/${root.replace(/\/+$/, '')}`;
}

export function getCdnConfig(env = {}) {
  const host = pick(env, 'CDN_DOWNLOAD_HOST').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const authKey = pick(env, 'CDN_AUTH_KEY');
  const tokenValidSeconds = Number(pick(env, 'CDN_TOKEN_VALID_SECONDS', '3600'));
  const normalizedTtl = Number.isFinite(tokenValidSeconds) ? Math.max(60, tokenValidSeconds) : 3600;

  // CDN 配置必须成对出现。旧版在只配置 CDN_DOWNLOAD_HOST 时会静默回退到
  // Cloud Function 的内部 pages-scf 域名，浏览器最终拿到不可访问的内部 URL。
  // 这里改为显式报错，避免错误链接被下发给前端。
  if (host && !authKey) {
    throw new InputError(
      '已配置 CDN_DOWNLOAD_HOST，但缺少 CDN_AUTH_KEY。请在 Makers 环境变量中配置与 EdgeOne Token 鉴权方式 D 主密钥完全一致的 CDN_AUTH_KEY。',
      'CDN_AUTH_KEY_MISSING',
      503
    );
  }
  if (!host && authKey) {
    throw new InputError(
      '已配置 CDN_AUTH_KEY，但缺少 CDN_DOWNLOAD_HOST。请填写独立的 EdgeOne CDN 下载域名。',
      'CDN_DOWNLOAD_HOST_MISSING',
      503
    );
  }

  return {
    host,
    authKey,
    tokenValidSeconds: normalizedTtl,
    enabled: Boolean(host && authKey)
  };
}
