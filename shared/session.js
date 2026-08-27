import { base64UrlToBytes, bytesToBase64Url, utf8Bytes, utf8Text } from './codec.js';

const TOKEN_VERSION = 'v1';

async function getKey(secret) {
  if (!secret || String(secret).length < 24) {
    throw new Error('WEBDAV_SESSION_SECRET 至少需要 24 个字符');
  }
  const material = await crypto.subtle.digest('SHA-256', utf8Bytes(secret));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealToken(payload, secret, ttlSeconds = 12 * 60 * 60) {
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + Math.max(60, Number(ttlSeconds) || 60)
  };
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    utf8Bytes(JSON.stringify(body))
  );
  return `${TOKEN_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function openToken(token, secret, expectedKind = null) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) throw new Error('会话令牌格式错误');
  try {
    const key = await getKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(parts[1]) },
      key,
      base64UrlToBytes(parts[2])
    );
    const payload = JSON.parse(utf8Text(new Uint8Array(decrypted)));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) throw new Error('会话已过期，请重新连接');
    if (expectedKind && payload.kind !== expectedKind) throw new Error('会话令牌用途不匹配');
    return payload;
  } catch (error) {
    if (error?.message === '会话已过期，请重新连接' || error?.message === '会话令牌用途不匹配') throw error;
    throw new Error('会话令牌无效');
  }
}
