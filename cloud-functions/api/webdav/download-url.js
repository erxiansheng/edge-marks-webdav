import { createHash } from 'node:crypto';
import { sha256Hex } from '../../../shared/codec.js';
import { getCdnConfig } from '../../../server/config.js';
import { corsPreflight, handleApiError, json, readJson } from '../../../server/http.js';
import { readWebDavSession } from '../../../server/session.js';
import { statPath } from '../../../server/webdav.js';
import { InputError, normalizeDavPath } from '../../../shared/webdav-common.js';

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

function encodeDavPath(path) {
  return normalizeDavPath(path, { allowRoot: false })
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const session = await readWebDavSession(body.session, context.env);
    const path = normalizeDavPath(body.path, { allowRoot: false });
    const stat = await statPath(session, path);
    const versionSource = stat.etag || stat.modified || `${stat.size || 0}`;
    const version = await sha256Hex(`${path}\u0000${versionSource}`);
    const cdn = getCdnConfig(context.env);

    if (!cdn.enabled) {
      throw new InputError('CDN 下载模式要求配置 CDN_DOWNLOAD_HOST、CDN_AUTH_KEY 与 CDN_ORIGIN_KEY。', 'CDN_NOT_CONFIGURED', 503);
    }

    // URL 路径包含不可变版本号 + WebDAV 相对路径。
    // CDN 回源仍请求同一路径到 Makers Cloud Function：
    // /download/<version>/<path> -> Cloud Function -> WebDAV Range。
    const encodedPath = encodeDavPath(path);
    const pathname = `/download/${version}/${encodedPath}`;
    const url = new URL(`https://${cdn.host}${pathname}`);
    const timestamp = String(Math.floor(Date.now() / 1000));
    url.searchParams.set('token', md5(`${cdn.authKey}${url.pathname}${timestamp}`));
    url.searchParams.set('t', timestamp);

    return json({
      ok: true,
      url: url.toString(),
      mode: 'edgeone-cdn-native-direct-link',
      file: {
        version,
        path,
        size: stat.size,
        etag: stat.etag,
        modified: stat.modified
      },
      cdn: {
        enabled: true,
        host: cdn.host,
        tokenValidSeconds: cdn.tokenValidSeconds,
        originMaxRangeBytes: cdn.rangeBytes,
        browserRangeAssembly: false,
        origin: 'makers-cloud-function',
        originProtected: true
      }
    });
  } catch (error) {
    return handleApiError(error, context);
  }
}

export function onRequestOptions() {
  return corsPreflight();
}
