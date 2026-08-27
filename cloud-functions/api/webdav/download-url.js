import { createHash } from 'node:crypto';
import { sha256Hex } from '../../../shared/codec.js';
import { sealToken } from '../../../shared/session.js';
import { getCdnConfig, getSessionSecret } from '../../../server/config.js';
import { corsPreflight, handleApiError, json, readJson } from '../../../server/http.js';
import { readWebDavSession } from '../../../server/session.js';
import { downloadFilename, statPath } from '../../../server/webdav.js';
import { normalizeDavPath } from '../../../shared/webdav-common.js';

function md5(value) { return createHash('md5').update(value).digest('hex'); }

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const path = normalizeDavPath(body.path, { allowRoot: false });
    const stat = await statPath(session, path);
    const version = stat.etag || stat.modified || `${stat.size || 0}`;
    const fileId = await sha256Hex(`${session.baseUrl}\u0000${session.username}\u0000${path}\u0000${version}`);
    const filename = downloadFilename(path);
    const cdn = getCdnConfig(context.env);
    const pathname = `/download/${fileId}`;
    const ticketTtl = cdn.enabled ? cdn.tokenValidSeconds : 60 * 60;
    const ticket = await sealToken({ kind: 'download-ticket', path, fileId, filename }, getSessionSecret(context.env), ticketTtl);

    // CDN 开启时始终使用独立 CDN 域名。未开启 CDN 时返回相对 URL，
    // 让浏览器使用当前公开站点域名；绝不再使用 context.request.url 的 origin，
    // 因为 Makers Cloud Function 内部看到的可能是 pages-scf-*.qcloudteo.com。
    let downloadUrl;
    if (cdn.enabled) {
      const url = new URL(pathname, `https://${cdn.host}`);
      url.searchParams.set('ticket', ticket);
      const timestamp = String(Math.floor(Date.now() / 1000));
      url.searchParams.set('token', md5(`${cdn.authKey}${pathname}${timestamp}`));
      url.searchParams.set('t', timestamp);
      downloadUrl = url.toString();
    } else {
      downloadUrl = `${pathname}?ticket=${encodeURIComponent(ticket)}`;
    }

    return json({
      ok: true,
      url: downloadUrl,
      mode: cdn.enabled ? 'edgeone-native-cdn' : 'origin-stream',
      file: { fileId, path, filename, size: stat.size, etag: stat.etag, modified: stat.modified },
      cdn: { enabled: cdn.enabled, host: cdn.host || null, tokenValidSeconds: cdn.tokenValidSeconds }
    });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() { return corsPreflight(); }
