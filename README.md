# EdgeOne Makers WebDAV Gateway v2.8

固定 WebDAV 后端 + EdgeOne CDN 大文件缓存 Demo。

v2.8 的核心原则是：**任何真正访问 WebDAV 的 HTTP 请求都只能由 Makers Cloud Function 发出。** Edge Function 不再直接连接 WebDAV，只负责 session 校验、KV 目录缓存和调用项目内部 Cloud Function。

```text
上传 / 管理：
浏览器 -> Makers Cloud Function -> WebDAV

目录读取：
浏览器 -> Makers Edge Function -> KV
                         |-- HIT -> 直接返回
                         `-- MISS -> Makers Cloud Function -> WebDAV PROPFIND

下载：
浏览器 -> EdgeOne CDN
              |-- HIT -> 直接返回
              `-- MISS -> Makers Cloud Function -> WebDAV Range
```

因此 WebDAV 侧看到的请求来源统一为 Cloud Function：

```text
PROPFIND / HEAD / GET / Range / PUT / MKCOL / DELETE
                         ↓
                 Makers Cloud Function
                         ↓
                      WebDAV
```

最终文件只保存在 WebDAV。Blob 不参与文件存储。KV 只保存短期目录元数据。

## 为什么所有 WebDAV 请求都统一经过 Cloud Function

目的是避免 CDN 节点或全球 Edge Function 直接访问 WebDAV。目录 KV MISS 的 `PROPFIND`、文件 `GET/Range`、上传 `PUT`、建目录 `MKCOL`、删除 `DELETE`、连接探测和文件属性读取现在全部由 Makers Cloud Function 发起。Edge Function 只操作 KV，不携带 WebDAV 密码发起上游请求。

注意：**固定 Cloud Function 地域不等于固定公网出口 IP**。Makers Cloud Function 仍是 Serverless。当前 `edgeone.json` 固定中国大陆 Cloud Function 到广州，只能让来源区域更加集中；如果必须让 WebDAV 永远只看到一个公网 IP，仍需要固定 EIP / 固定出口代理。

## 原生直链下载与 Range 说明

v2.8 不再让前端把大文件拆成 Range 后自行拼接。点击“下载”后，Cloud Function 只负责生成一个带 Token D 的 CDN 直链，然后直接交给浏览器/系统下载器：

```text
点击下载
  ↓
POST /api/webdav/download-url
  ↓
返回 https://123cdn.example.com/download/<version>/<path>?token=...&t=...
  ↓
浏览器原生下载
  ↓
EdgeOne CDN
  |-- HIT -> 直接返回
  `-- MISS -> 分片回源 -> Makers Cloud Function -> WebDAV Range
```

这样可以使用浏览器原生下载管理、暂停/续传（取决于浏览器/CDN/源站 Range 支持），也不需要前端把整个文件放进内存或自行写磁盘。

### 为什么仍保留 `CDN_RANGE_BYTES=4194304`

Cloud Function 请求/响应 Body 上限为 6 MB，因此下载源站路由仍将**单次回源 Range 的安全上限**限制为 4 MiB：

```env
CDN_RANGE_BYTES=4194304
```

这个值现在是 Cloud Function 的安全上限，不再代表浏览器主动分片大小。

重要：EdgeOne 当前公开的“分片回源”配置主要提供开关，平台实际向源站请求的分片大小由 EdgeOne 控制。应用代码无法在保持单一原生直链的同时强制 CDN 一定按 4 MiB 回源。只要 EdgeOne 每次回源 Range 不超过 4 MiB，本项目即可正常代理；平台默认较小分片同样可以工作。

---

# 1. 环境变量

## 必填：WebDAV

```env
WEBDAV_BASE_URL=https://webdav.example.com/webdav
WEBDAV_USERNAME=your_username
WEBDAV_PASSWORD=your_password
WEBDAV_SESSION_SECRET=replace_with_a_long_random_secret_at_least_24_chars
WEBDAV_INTERNAL_KEY=replace_with_a_separate_internal_secret_at_least_24_chars
```

说明：

- `WEBDAV_BASE_URL`：WebDAV 根地址，必须 HTTPS。
- `WEBDAV_USERNAME`：WebDAV 用户名。
- `WEBDAV_PASSWORD`：WebDAV 密码。
- `WEBDAV_SESSION_SECRET`：浏览器无凭据 session 的加密密钥，至少 24 字符，建议 32~64 位随机值。
- `WEBDAV_INTERNAL_KEY`：Edge Function 在 KV MISS 时调用内部目录 Cloud Function 的独立密钥，至少 24 字符，建议 32~64 位随机值。不要与 `WEBDAV_SESSION_SECRET`、`CDN_AUTH_KEY` 或 `CDN_ORIGIN_KEY` 共用。

浏览器不会收到 `WEBDAV_PASSWORD` 或 `WEBDAV_INTERNAL_KEY`。

## 必填：CDN

```env
CDN_DOWNLOAD_HOST=123cdn.example.com
CDN_AUTH_KEY=replace_with_edgeone_token_auth_method_d_key
CDN_TOKEN_VALID_SECONDS=3600
CDN_ORIGIN_KEY=replace_with_a_separate_random_origin_secret
CDN_RANGE_BYTES=4194304
```

说明：

- `CDN_DOWNLOAD_HOST`：独立 EdgeOne CDN 下载域名，不带 `https://`。
- `CDN_AUTH_KEY`：必须与 EdgeOne Token 鉴权“方式 D”的主密钥完全一致。
- `CDN_TOKEN_VALID_SECONDS`：下载 URL 有效时间，建议 3600 秒。
- `CDN_ORIGIN_KEY`：CDN 回源到 Makers 时注入的独立密钥，至少 24 字符；**不要和 CDN_AUTH_KEY 使用同一个值**。
- `CDN_RANGE_BYTES`：Cloud Function 可接受的单次 CDN 回源 Range 上限；默认/最大 4 MiB。它不强制 EdgeOne 实际使用 4 MiB 分片。

## 可选

```env
WEBDAV_ALLOWED_HOSTS=webdav.example.com
WEBDAV_CHUNK_BYTES=4194304
WEBDAV_MAX_UPLOAD_BYTES=8589934592
WEBDAV_TEMP_DIR=/.edgeone-upload
WEBDAV_SESSION_TTL_SECONDS=43200
DIRECTORY_CACHE_TTL_MS=15000
```

### 完整示例

```env
WEBDAV_BASE_URL=https://webdav.example.com/webdav
WEBDAV_USERNAME=your_username
WEBDAV_PASSWORD=your_password
WEBDAV_SESSION_SECRET=replace_with_random_32_to_64_chars
WEBDAV_INTERNAL_KEY=replace_with_another_random_32_to_64_chars
WEBDAV_ALLOWED_HOSTS=webdav.example.com

WEBDAV_CHUNK_BYTES=4194304
WEBDAV_MAX_UPLOAD_BYTES=8589934592
WEBDAV_TEMP_DIR=/.edgeone-upload
WEBDAV_SESSION_TTL_SECONDS=43200
DIRECTORY_CACHE_TTL_MS=15000

CDN_DOWNLOAD_HOST=123cdn.example.com
CDN_AUTH_KEY=replace_with_token_d_secret
CDN_TOKEN_VALID_SECONDS=3600
CDN_ORIGIN_KEY=replace_with_another_random_32_to_64_chars
CDN_RANGE_BYTES=4194304
```

---

# 2. KV 绑定

KV 只缓存目录列表 JSON，不缓存文件内容，不保存 WebDAV 密码。

在 Makers 项目绑定一个 KV Namespace，变量名固定：

```text
WEBDAV_KV
```

未绑定也能运行，目录接口会显示：

```text
KV BYPASS
```

## 目录读取的内部调用链

v2.8 中 Edge Function **绝不直接 `PROPFIND` WebDAV**。KV MISS 时只调用同项目的内部 Cloud Function：

```text
POST /api/webdav/list
        ↓
Makers Edge Function
        ↓
读取 WEBDAV_KV
  |-- HIT -> 返回
  `-- MISS
        ↓
POST /api/internal/webdav/list
X-WebDAV-Internal-Key: <WEBDAV_INTERNAL_KEY>
        ↓
Makers Cloud Function
        ↓ PROPFIND
WebDAV
        ↓
Cloud Function -> Edge Function -> 写入 KV -> 浏览器
```

`/api/internal/webdav/list` 会同时校验：

- `X-WebDAV-Internal-Key` 必须与 Makers 的 `WEBDAV_INTERNAL_KEY` 完全一致；
- 浏览器 session 仍必须有效；
- WebDAV 用户名和密码只由 Cloud Function 从 Makers 环境变量读取。

直接从浏览器调用内部目录接口且没有正确 Internal Key 会返回 `403 INTERNAL_ORIGIN_FORBIDDEN`。

---

# 3. Makers Cloud Function 地域

`edgeone.json` 当前固定中国大陆 Cloud Function 地域为广州：

```json
{
  "cloudFunctions": {
    "mainlandRegions": ["ap-guangzhou"],
    "nodejs": {
      "maxDuration": 120
    }
  }
}
```

这样可以避免中国大陆请求在多个 Cloud Function 地域之间随机部署。

如果项目加速区域包含中国大陆以外，EdgeOne 还会涉及海外 Cloud Function 地域。可以在控制台或 `edgeone.json` 中额外固定一个 `overseasRegions` 地域。

---

# 4. EdgeOne CDN 域名配置

以下示例假设：

```text
Makers 自定义域名：test6.example.com
CDN 下载域名：     123cdn.example.com
```

## CDN 源站

`123cdn.example.com` 的源站配置：

```text
源站类型：域名
源站：test6.example.com
回源协议：HTTPS
HTTPS 端口：443
回源 HOST：test6.example.com
```

**不要再把 CDN 源站配置成 WebDAV。**

正确链路必须是：

```text
123cdn.example.com
        ↓
test6.example.com
        ↓
Makers Cloud Function
        ↓
WebDAV
```

---

# 5. `/download/*` 规则引擎

创建一条只针对下载路径的规则。

匹配条件：

```text
HOST = 123cdn.example.com
AND
URL Path 前缀匹配 /download/
```

建议配置以下操作。

## 5.1 节点缓存

```text
节点缓存 TTL：30 天
强制缓存：开启
```

下载 URL 使用版本化路径，并直接作为浏览器原生下载直链：

```text
/download/<version>/<webdav-relative-path>
```

文件 ETag / Last-Modified / Size 发生变化后会生成新 `version`，因此适合长缓存。

## 5.2 Cache Key

```text
查询字符串：全部忽略
```

因为：

```text
/download/AAA/file.zip?token=111&t=111
/download/AAA/file.zip?token=222&t=222
```

实际都是同一个版本的文件缓存。

## 5.3 Token 鉴权

```text
方式：D
主鉴权密钥：与 Makers CDN_AUTH_KEY 完全一致
鉴权加密串参数：token
时间戳参数：t
时间格式：十进制 Unix 时间戳
有效时长：3600 秒
```

## 5.4 分片回源

```text
分片回源：开启
```

必须开启，原因是普通浏览器完整文件请求如果 CDN MISS，需要 EdgeOne 把大文件拆成 Range 请求，否则 Cloud Function 无法一次返回 >6 MB 的文件。

浏览器现在只请求一条普通 CDN 直链，不主动拆 Range。EdgeOne 在 CDN MISS 时负责按“分片回源”机制向 Cloud Function 发 Range。Cloud Function 将收到的单段 Range 原样转发到 WebDAV。

## 5.5 关键：注入 Origin Key

增加操作：

```text
修改 HTTP 回源请求头
```

设置：

```text
Header：X-CDN-Origin-Key
值：与 Makers CDN_ORIGIN_KEY 完全一致
```

例如 Makers：

```env
CDN_ORIGIN_KEY=some_random_secret_32_chars_or_more
```

EdgeOne 回源规则：

```http
X-CDN-Origin-Key: some_random_secret_32_chars_or_more
```

这样用户直接访问：

```text
https://test6.example.com/download/...
```

会得到：

```text
403 CDN_ORIGIN_FORBIDDEN
```

只有真正经过 EdgeOne CDN 的回源请求才允许访问下载 Cloud Function。

## 5.6 回源查询参数

建议：

```text
回源请求参数设置 -> 查询字符串全部忽略
```

`token` 和 `t` 只用于 EdgeOne 节点鉴权，Makers Cloud Function 不需要这两个参数。

## 5.7 不要配置这些旧版项目规则

v2.8 **不需要**：

```text
Authorization: Basic ...
```

也**不需要**把 `/download/*` 重写到 `/webdav/*`。

这些是 v2.4 CDN 直接回源 WebDAV 的旧配置，应删除。

---

# 6. WebDAV 出口与调用链

## 6.1 所有 WebDAV 请求的统一出口

部署 v2.8 后，WebDAV 服务器不应再收到来自 Makers Edge Function 或 EdgeOne CDN 节点直接发出的请求：

| WebDAV 操作 | 发起方 |
| --- | --- |
| 连接探测 `PROPFIND Depth: 0` | Makers Cloud Function |
| 目录列表 `PROPFIND Depth: 1` | Makers Cloud Function（Edge KV MISS 时内部调用） |
| 文件属性 / 下载 URL 元数据读取 | Makers Cloud Function |
| 上传 `PUT` / 临时分片 `PUT` / 合并 | Makers Cloud Function |
| 建目录 `MKCOL` | Makers Cloud Function |
| 删除 `DELETE` | Makers Cloud Function |
| 下载 `GET / Range` | Makers Cloud Function（仅 CDN MISS） |

Edge Function 的职责只剩：session 校验、读取/写入 `WEBDAV_KV`、调用内部 Cloud Function。Edge Function 代码不再构造 WebDAV Basic Auth，也不再对 WebDAV 域名执行 `fetch()`。

## 6.2 下载调用链

### CDN HIT

```text
浏览器
  ↓
123cdn.example.com
  ↓
EdgeOne CDN HIT
  ↓
直接返回
```

WebDAV 请求数：0。

### CDN MISS + EdgeOne 分片回源

```text
浏览器
GET /download/<version>/<path>?token=...&t=...
  ↓
EdgeOne CDN
  ↓ MISS / 分片回源
Range: bytes=<由 EdgeOne 决定的单段范围>
X-CDN-Origin-Key: ***
  ↓
Makers Cloud Function
  ↓
Authorization: Basic ***
Range: 原样转发
  ↓
WebDAV
  ↓ 206
Cloud Function
  ↓ 206
EdgeOne CDN 缓存
  ↓
浏览器原生下载
```

### Cloud Function 下载路由

项目新增：

```text
cloud-functions/download/[[path]].js
```

路由：

```text
/download/<64位版本号>/<WebDAV相对路径>
```

特性：

- 只允许 `GET` / `HEAD` / `OPTIONS`。
- `GET` 必须来自正确 `X-CDN-Origin-Key`。
- 单段 Range 默认最大 4 MiB。
- Range 原样转发至 WebDAV。
- Range 请求要求 WebDAV 返回 `206 Partial Content`。
- 不调用 `arrayBuffer()` 读取完整大文件；响应直接流式透传。
- `200/206` 响应带可缓存 Header 和 CORS Header。

---

# 7. 大文件上传

Cloud Function Body 上限 6 MB，上传继续采用 v2.2 之后的 JSON Base64 方案。

## <= 4 MiB

```text
浏览器
  ↓ Base64 JSON
Cloud Function
  ↓ PUT
WebDAV
```

## > 4 MiB

```text
浏览器
  ↓ 4 MiB 分片 + Base64 JSON
Cloud Function
  ↓
WebDAV /.edgeone-upload/<uploadId>/000000.part
WebDAV /.edgeone-upload/<uploadId>/000001.part
...
  ↓
Cloud Function 流式合并 PUT
  ↓
最终 WebDAV 文件
  ↓
删除临时目录
```

不使用 Blob。

最终合并仍受 Cloud Function 120 秒执行时间限制。

---

# 8. 部署后的验证方法

## 验证下载 URL

调用：

```text
POST /api/webdav/download-url
```

应返回类似：

```json
{
  "mode": "edgeone-cdn-native-direct-link",
  "url": "https://123cdn.example.com/download/<version>/path/file.zip?token=...&t=...",
  "cdn": {
    "host": "123cdn.example.com",
    "originMaxRangeBytes": 4194304,
    "browserRangeAssembly": false,
    "origin": "makers-cloud-function",
    "originProtected": true
  }
}
```

不应再出现：

```text
edgeone-direct-webdav
```

也不应出现 Makers 内部 `pages-scf-...qcloudteo.com` 下载地址。

## 验证目录请求已经全部从 Cloud Function 出口

第一次打开一个未缓存目录时，`POST /api/webdav/list` 响应应包含：

```text
X-KV-Cache: MISS
X-WebDAV-Origin: CLOUD-FUNCTION
```

JSON 中也会看到：

```json
{
  "cache": {
    "layer": "kv",
    "hit": false,
    "webdavOrigin": "makers-cloud-function"
  }
}
```

再次读取同目录并命中 KV 时：

```text
X-KV-Cache: HIT
X-WebDAV-Origin: NONE
```

这次不会请求 Cloud Function，也不会请求 WebDAV。

如果直接访问 `/api/internal/webdav/list` 且没有内部密钥，应返回：

```text
403 INTERNAL_ORIGIN_FORBIDDEN
```

## 验证原生直链与分片回源

浏览器 F12 Network 应看到一个指向 `CDN_DOWNLOAD_HOST` 的普通下载请求，例如：

```text
https://123cdn.example.com/download/<version>/path/file.zip?token=...&t=...
```

前端不再自行发送连续 Range，也不再拼接文件。

当 CDN 缓存 MISS 时，在 EdgeOne 回源日志、Makers Cloud Function 日志或 WebDAV 请求日志中应看到 `Range` 请求。具体单段大小由 EdgeOne 分片回源机制决定；Cloud Function 允许的单段上限由 `CDN_RANGE_BYTES` 控制，最大 4 MiB。

## 验证 CDN HIT

同一版本文件再次下载时检查：

```text
EO-Cache-Status
```

缓存命中后不会再请求 Cloud Function / WebDAV。

---

# 9. 安全建议

- `WEBDAV_PASSWORD`、`WEBDAV_SESSION_SECRET`、`WEBDAV_INTERNAL_KEY`、`CDN_AUTH_KEY`、`CDN_ORIGIN_KEY` 都不要提交到 Git。
- `WEBDAV_INTERNAL_KEY`、`CDN_AUTH_KEY` 与 `CDN_ORIGIN_KEY` 使用三个不同的随机值。
- Internal Key 与 CDN Origin Key 都至少 24 位，建议 32~64 位。
- 对 `/download/*` 保留 Token D 鉴权。
- 不要开放 Cloud Function 下载 origin 给公网直接调用。
- WebDAV 必须 HTTPS。
- 若仅使用 123 WebDAV，建议将 `WEBDAV_ALLOWED_HOSTS` 限制到对应 WebDAV 域名。
- 目录 KV 不存密码，不存文件内容。
- Edge Function 不再直连 WebDAV；如果 WebDAV 日志仍出现明显来自全球 Edge 节点的 `PROPFIND`，说明线上仍部署了旧版目录函数或缓存规则未更新。

---

# 10. 本地测试

```bash
npm run check
npm test
npm run build
```

当前测试覆盖：

- 环境变量 WebDAV 凭据。
- `WEBDAV_INTERNAL_KEY` 保护内部目录 Cloud Function。
- Edge Function KV MISS 只调用内部 Cloud Function，不直接请求 WebDAV。
- 内部目录 Cloud Function 统一发出 `PROPFIND` 到 WebDAV。
- Edge Function KV HIT 时 WebDAV / Cloud Function 请求数为 0。
- session 不包含账号密码。
- Makers body 已被解析情况下的 Base64 分片上传。
- 4 MiB 上传分片。
- 大文件 WebDAV 临时分片合并。
- CDN Token D URL。
- `CDN_ORIGIN_KEY` 防绕过。
- Cloud Function 单段 Range 转发与 4 MiB 安全上限。
- 206 / Content-Range / CORS。
- >4 MiB Range 拒绝。
- 不同单段 Range 大小与 4 MiB 上限。

### 冷缓存首次下载的 1-byte Range 探测

浏览器仍然只使用一个最终下载直链，不会在前端分片或拼接大文件。为了兼容 EdgeOne 冷缓存首次完整 GET 的分片回源识别，前端在交给浏览器原生下载前会先对同一个 CDN URL 发起一次：

```http
Range: bytes=0-0
```

该请求只读取 1 byte，用于让 CDN 获取源站的 `206`、`Content-Range`、文件总大小和 Range 支持信息。探测完成后立即通过同一条 CDN URL 启动浏览器原生下载。

```text
点击下载
  ↓
Cloud Function 生成 CDN 直链
  ↓
1-byte Range 探测（仅元数据/首字节，不拼接文件）
  ↓
浏览器原生 GET 下载
  ↓
EdgeOne CDN HIT 或分片回源
  ↓ MISS
Makers Cloud Function → WebDAV Range
```

如果日志仍出现 `RANGE_REQUIRED`，请先确认 1-byte 探测请求是否返回 `206` 且响应包含类似 `Content-Range: bytes 0-0/123456789`。
