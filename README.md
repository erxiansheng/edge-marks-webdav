# EdgeOne Makers WebDAV Gateway v2.2

一个适合部署在腾讯云 EdgeOne Makers 的固定后端 WebDAV 网关。WebDAV 地址、账号和密码全部由 Makers **环境变量**提供，前端不再输入或保存 WebDAV 凭据。

项目目标：

- 文件最终只保存在 WebDAV。
- 不使用 Blob 保存文件。
- Cloud Function 负责 WebDAV 管理、普通上传和大文件分片上传。上传实体统一使用 JSON + Base64 传输，规避 Makers Node.js 运行时对原始二进制 Request body 的重复消费问题。
- Edge Function 负责目录读取 / KV 元数据缓存，以及 CDN MISS 时的大文件 Range 回源。
- 独立 EdgeOne 站点加速域名负责大文件 CDN / Range 缓存。
- WebDAV 密码不进入前端、不进入 KV，也不封装进浏览器 session token 或下载 ticket。

---

## 1. 架构

```text
                           EdgeOne Makers
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
      静态前端              Cloud Function       Edge Function
           │                    │                    │
           │                    ├─ 创建目录          ├─ 目录读取
           │                    ├─ 删除              ├─ KV 目录缓存
           │                    ├─ ≤4 MiB 上传       └─ CDN MISS 下载网关
           │                    └─ >4 MiB 分片上传          │
           │                            │                    │ Range
           └────────────────────────────┴──────────────→ WebDAV
                                                        │
                                                        │ 文件本体
                                                        ▼
                                             EdgeOne 原生 CDN
                                                        │
                                                   CDN HIT
                                                        │
                                                        ▼
                                                       用户
```

### 数据保存位置

| 数据 | 保存位置 |
| --- | --- |
| 最终文件 | WebDAV |
| 大文件上传临时分片 | WebDAV `/.edgeone-upload/...`，合并成功后删除 |
| WebDAV 地址 | Makers 环境变量 |
| WebDAV 账号 | Makers 环境变量 |
| WebDAV 密码 | Makers 环境变量 |
| 浏览器 session | 短期加密 token，不包含 WebDAV 地址/账号/密码 |
| 下载 ticket | 短期加密 token，只包含文件 path / fileId / filename，不包含 WebDAV 凭据 |
| 目录列表元数据 | KV，可选 |
| 下载文件内容 | EdgeOne CDN 节点缓存 |
| Blob | 不使用 |

---

## 2. 必须配置的环境变量

进入：

```text
EdgeOne Makers
→ 你的项目
→ 设置
→ 环境变量
→ Production / 生产环境
```

至少配置下面 4 个变量：

| 环境变量 | 是否必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `WEBDAV_BASE_URL` | 是 | `https://webdav.example.com/webdav` | WebDAV 根地址，必须为 HTTPS |
| `WEBDAV_USERNAME` | 是 | `your_username` | WebDAV 账号 |
| `WEBDAV_PASSWORD` | 是 | `your_password` | WebDAV 密码，仅服务端读取 |
| `WEBDAV_SESSION_SECRET` | 是 | 长随机字符串 | 用于签发 session / download ticket，至少 24 字符 |

推荐生成一个长度至少 32～64 字符的随机 `WEBDAV_SESSION_SECRET`。

完整最小配置：

```env
WEBDAV_BASE_URL=https://webdav.example.com/webdav
WEBDAV_USERNAME=your_username
WEBDAV_PASSWORD=your_password
WEBDAV_SESSION_SECRET=replace_with_a_long_random_secret_at_least_24_chars
```

> 不要把真实账号、密码或 `WEBDAV_SESSION_SECRET` 写进 GitHub、`.env.example`、前端 JavaScript 或 README。

---

## 3. WebDAV 可选环境变量

| 环境变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `WEBDAV_ALLOWED_HOSTS` | 自动取 `WEBDAV_BASE_URL` 的 hostname | WebDAV 主机白名单；支持逗号分隔和 `*.example.com` |
| `WEBDAV_CHUNK_BYTES` | `4194304` | 大文件浏览器分片大小，默认且最大 4 MiB；Base64 后约 5.34 MiB，留在 Cloud Function 6 MB Body 限制内 |
| `WEBDAV_MAX_UPLOAD_BYTES` | `8589934592` | 单文件最大上传大小，默认 8 GiB |
| `WEBDAV_TEMP_DIR` | `/.edgeone-upload` | WebDAV 临时上传分片目录 |
| `WEBDAV_SESSION_TTL_SECONDS` | `43200` | 浏览器 session 有效期，默认 12 小时 |
| `DIRECTORY_CACHE_TTL_MS` | `15000` | KV 目录缓存逻辑 TTL，默认 15 秒 |

推荐配置：

```env
WEBDAV_ALLOWED_HOSTS=webdav.example.com
WEBDAV_CHUNK_BYTES=4194304
WEBDAV_MAX_UPLOAD_BYTES=8589934592
WEBDAV_TEMP_DIR=/.edgeone-upload
WEBDAV_SESSION_TTL_SECONDS=43200
DIRECTORY_CACHE_TTL_MS=15000
```

### `WEBDAV_ALLOWED_HOSTS`

固定 WebDAV 模式下，如果不填写这个变量，程序会自动只允许 `WEBDAV_BASE_URL` 自身 hostname。

例如：

```env
WEBDAV_BASE_URL=https://webdav.example.com/webdav
```

则默认只允许：

```text
webdav.example.com
```

如果你的 WebDAV 会跳转到其他同域子站，可以显式配置：

```env
WEBDAV_ALLOWED_HOSTS=webdav.example.com,*.example.com
```

---

## 4. CDN 下载环境变量

如果只想使用 Makers 自身流式下载，可以不配置 CDN。

如果要启用独立 EdgeOne CDN 下载域名，则还必须配置：

| 环境变量 | 是否必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `CDN_DOWNLOAD_HOST` | CDN 模式必填 | `123cdn.dasb.cn` | 独立 EdgeOne 加速域名，只填 hostname，不带 `https://` |
| `CDN_AUTH_KEY` | CDN 模式必填 | 随机密钥 | 必须和 EdgeOne Token 鉴权「方式 D」主密钥一致 |
| `CDN_TOKEN_VALID_SECONDS` | 否 | `3600` | 下载签名有效期，默认 1 小时 |

例如你当前的 CDN 域名是：

```env
CDN_DOWNLOAD_HOST=123cdn.dasb.cn
CDN_AUTH_KEY=replace_with_the_same_key_configured_in_edgeone
CDN_TOKEN_VALID_SECONDS=3600
```

**注意：`CDN_DOWNLOAD_HOST` 和 `CDN_AUTH_KEY` 必须同时存在。** v2.3 起如果只配置域名、不配置密钥，接口会直接返回 `CDN_AUTH_KEY_MISSING`，不会再静默生成 Makers 内部 `pages-scf-*.qcloudteo.com` 地址。

`CDN_AUTH_KEY` 必须同时配置在：

```text
EdgeOne 站点加速
→ 123cdn.dasb.cn
→ Token 鉴权
→ 方式 D
```

并与 Makers 环境变量里的值完全相同。

### CDN 下载 URL

项目会自动生成类似：

```text
https://123cdn.dasb.cn/download/<fileId>?ticket=...&token=...&t=...
```

其中：

- `/download/<fileId>` 是稳定、版本化的 CDN Cache Key。
- `ticket` 只保存文件 path / fileId / filename，不保存 WebDAV 凭据。
- `token` + `t` 用于 EdgeOne Token 鉴权方式 D。
- CDN MISS 时 Edge Function 才从环境变量读取 WebDAV 账号密码并回源。

---

## 5. 一份完整的环境变量示例

```env
# ===== WebDAV：必填 =====
WEBDAV_BASE_URL=https://webdav.example.com/webdav
WEBDAV_USERNAME=your_webdav_username
WEBDAV_PASSWORD=your_webdav_password
WEBDAV_SESSION_SECRET=replace_with_a_long_random_secret_at_least_24_chars

# ===== WebDAV：可选 =====
WEBDAV_ALLOWED_HOSTS=webdav.example.com
WEBDAV_CHUNK_BYTES=4194304
WEBDAV_MAX_UPLOAD_BYTES=8589934592
WEBDAV_TEMP_DIR=/.edgeone-upload
WEBDAV_SESSION_TTL_SECONDS=43200
DIRECTORY_CACHE_TTL_MS=15000

# ===== EdgeOne CDN：启用 CDN 时配置 =====
CDN_DOWNLOAD_HOST=123cdn.dasb.cn
CDN_AUTH_KEY=replace_with_edgeone_type_d_auth_key
CDN_TOKEN_VALID_SECONDS=3600
```

### 环境变量清单汇总

```text
WEBDAV_BASE_URL
WEBDAV_USERNAME
WEBDAV_PASSWORD
WEBDAV_SESSION_SECRET
WEBDAV_ALLOWED_HOSTS
WEBDAV_CHUNK_BYTES
WEBDAV_MAX_UPLOAD_BYTES
WEBDAV_TEMP_DIR
WEBDAV_SESSION_TTL_SECONDS
DIRECTORY_CACHE_TTL_MS
CDN_DOWNLOAD_HOST
CDN_AUTH_KEY
CDN_TOKEN_VALID_SECONDS
```

另外还有一个 **KV Binding**：

```text
WEBDAV_KV
```

它不是普通字符串环境变量，需要在 Makers 控制台绑定 KV Namespace。

---

## 6. KV 目录缓存

KV 是可选功能。不绑定 KV 也能正常浏览、上传和下载。

如果需要目录缓存：

1. 在 EdgeOne Makers 创建 KV Namespace。
2. 绑定到当前项目。
3. Binding / 变量名固定填写：

```text
WEBDAV_KV
```

目录读取流程：

```text
浏览器
  ↓
Edge Function
  ↓
WEBDAV_KV
  ├─ HIT  → 直接返回目录 JSON
  └─ MISS → WebDAV PROPFIND → 写入 KV → 返回
```

上传、删除或新建目录后，前端会主动调用缓存失效接口。

KV 只保存目录列表 JSON，不保存：

- WebDAV 密码
- WebDAV 文件内容
- 上传分片
- CDN 文件缓存

---

## 7. EdgeOne CDN 域名配置

推荐使用两个**自定义域名**：

```text
test6.dasb.cn      → EdgeOne Makers 项目自定义域名
123cdn.dasb.cn     → EdgeOne 站点加速
                       ↓
                  源站：https://test6.dasb.cn
                  回源 HOST：test6.dasb.cn
```

> **不要把 `*.edgeone.cool` 项目域名或 Deployment/Preview 域名直接作为 CDN 源站。** 在部分加速区域下，Makers 项目域名需要带 3 小时有效的 Preview 鉴权信息；CDN 回源不会携带这个 Preview 凭据，会得到 `401 UNAUTHORIZED / Authentication Expired`。稳定回源应绑定并使用 Makers 自定义域名，例如当前部署的 `test6.dasb.cn`。

你的 CDN 域名规则建议只匹配：

```text
/download/*
```

建议配置：

```text
节点缓存 TTL：30 天
强制缓存：开启
分片回源：开启
Cache Key：忽略全部 Query String
Token 鉴权：方式 D
```

### 为什么 Cache Key 要忽略 Query String

同一个文件每次生成的短期鉴权参数可能不同：

```text
/download/ABC?ticket=111&token=AAA&t=111
/download/ABC?ticket=222&token=BBB&t=222
```

但真正代表文件版本的是：

```text
/download/ABC
```

因此 CDN 应忽略 Query String，使不同临时签名仍命中同一份节点缓存。

> 必须同时启用 Token 鉴权，不能只忽略 Query String，否则缓存文件的访问控制会变弱。

---


### CDN 下载故障快速判断

#### 生成的下载地址是 `pages-scf-*.qcloudteo.com`

旧版在只配置 `CDN_DOWNLOAD_HOST`、但没有 `CDN_AUTH_KEY` 时会回退到 Cloud Function 内部请求 origin，可能生成：

```text
https://pages-pro-xx.pages-scf-xx.qcloudteo.com/download/...
```

这个地址不是公网业务入口。v2.3 已修复：

- CDN 配置完整时，下载 URL 必须以 `https://CDN_DOWNLOAD_HOST/download/...` 开头；
- CDN 配置不完整时直接返回明确配置错误；
- 完全不启用 CDN 时只返回 `/download/...` 相对路径，由浏览器使用当前 Makers 自定义域名。

#### CDN 域名返回 `401 UNAUTHORIZED / Authentication Expired`

如果错误页是 Makers 的 `Access Restricted or Authentication Expired`，通常说明 CDN 回源到了受 Preview 鉴权保护的 Makers 项目域名/部署域名。请把 CDN 源站改为稳定的 Makers 自定义域名：

```text
加速域名：123cdn.dasb.cn
源站：test6.dasb.cn
回源协议：HTTPS
回源端口：443
回源 HOST：test6.dasb.cn
```

同时确认下载 URL 含有：

```text
?ticket=...&token=<32位md5>&t=<Unix秒时间戳>
```

如果 CDN 规则启用了 Token 鉴权方式 D，但 URL 没有 `token` / `t`，检查 Makers 是否同时配置：

```env
CDN_DOWNLOAD_HOST=123cdn.dasb.cn
CDN_AUTH_KEY=与 EdgeOne 方式 D 主密钥完全一致
CDN_TOKEN_VALID_SECONDS=3600
```

## 8. WebDAV 登录流程

前端已经不再提供：

```text
WebDAV 地址输入框
账号输入框
密码输入框
```

用户点击：

```text
连接并探测
```

服务端执行：

```text
读取 WEBDAV_BASE_URL
读取 WEBDAV_USERNAME
读取 WEBDAV_PASSWORD
        ↓
PROPFIND 探测 WebDAV
        ↓
成功
        ↓
签发无凭据 session token
        ↓
浏览器开始文件管理
```

浏览器只能看到：

- WebDAV URL
- 脱敏后的用户名
- 探测状态
- 延迟
- session token

浏览器不会收到 WebDAV 密码。

---

## 9. 大文件上传

### 为什么 v2.2 不再让 Cloud Function 直接 `request.arrayBuffer()`？

Makers Node.js 运行时/适配层在部分请求场景中可能已经读取或解析 `Request.body`。如果函数再次调用 `request.arrayBuffer()` / `request.json()`，Undici 会抛出：

```text
TypeError: Body is unusable: Body has already been read
```

v2.2 从源头规避这个问题：**浏览器上传给 Cloud Function 的文件实体统一编码成 JSON + Base64**。服务端的 `readJson()` 还会优先复用 Makers 已经解析好的 `request.body`，不会二次消费 Request body。

> Base64 会膨胀约 4/3。4 MiB 二进制分片编码后约 5.34 MiB，仍低于 Cloud Function 6 MB 请求 Body 上限，因此 `WEBDAV_CHUNK_BYTES` 在 v2.2 中最大固定为 4 MiB。

### ≤ 4 MiB

```text
浏览器 File/Blob
  ↓ Base64
POST application/json
  ↓
Cloud Function
  ↓ Base64 解码为二进制
WebDAV PUT
```

### > 4 MiB

```text
浏览器
  ↓ 每片最多 4 MiB
Blob.slice()
  ↓ Base64
POST /api/webdav/upload/chunk
  ↓
Cloud Function 解码
  ↓ PUT
WebDAV /.edgeone-upload/<uploadId>/000000.part
WebDAV /.edgeone-upload/<uploadId>/000001.part
...
        ↓
Cloud Function 流式读取临时分片
        ↓
最终 WebDAV PUT
        ↓
成功后删除临时分片目录
```

当前主上传接口：

```text
POST /api/webdav/file
POST /api/webdav/upload/chunk
```

旧版原始二进制 `PUT` 路由仍保留为兼容入口，但 Demo 前端不再使用它们。

这个方案不使用 Blob。

注意：分片上传绕开的是 Cloud Function 单次请求 Body 大小限制，但**最终合并仍受 Cloud Function 最大执行时间约束**。WebDAV 很慢、文件特别大时，最终合并可能超时。

---

## 10. 大文件下载与 CDN

启用 CDN 后：

```text
浏览器 Range 请求
        ↓
123cdn.dasb.cn
        ↓
EdgeOne CDN
  ├─ HIT  → 节点直接返回
  └─ MISS → Makers Edge Function
                ↓
          从环境变量读取凭据
                ↓ Authorization + Range
              WebDAV
                ↓ 200 / 206 Stream
          EdgeOne CDN 缓存
                ↓
              浏览器
```

下载不经过 Cloud Function，因此不会被 Cloud Function 的小响应 Body 上限限制。

Edge Function 不会把整个大文件读入内存，而是直接透传 WebDAV `ReadableStream`。

---

## 11. 项目结构

```text
cloud-functions/
  api/webdav/
    session.js
    file.js
    folder.js
    delete.js
    download-url.js
    upload/
      init.js
      chunk.js
      complete.js
      cancel.js

edge-functions/
  api/webdav/
    list.js
    cache/invalidate.js
  download/[fileId].js

server/
shared/
index.html
app.js
styles.css
edgeone.json
.env.example
README.md
```

---

## 12. 部署

项目已经包含 `edgeone.json`：

```text
Node.js：20.18.0
Cloud Function maxDuration：120 秒
构建命令：npm run build
输出目录：dist
```

推荐步骤：

1. Fork / 上传到 GitHub 私有或公开仓库。
2. 在 EdgeOne Makers 导入项目。
3. 配置所有必填环境变量。
4. 如需 KV，绑定 `WEBDAV_KV`。
5. 如需 CDN，配置 `CDN_DOWNLOAD_HOST` / `CDN_AUTH_KEY`。
6. 重新触发 Production 部署。
7. 打开前端点击“连接并探测”。
8. 上传一个小文件测试 WebDAV 写入。
9. 下载同一文件两次，确认 CDN 第二次开始出现缓存命中。

---

## 13. 本地开发

```bash
npm install
npm run check
npm test
npm run build
```

使用 EdgeOne CLI 时，本地环境变量可以放在本地私有配置中，但不要提交真实 `.env`。

`.gitignore` 应始终排除：

```text
.env
.env.local
.env.*.local
```

---

## 14. 安全注意事项

1. **WebDAV 必须使用 HTTPS。**
2. **不要把 `WEBDAV_PASSWORD` 提交到 Git。**
3. **不要把 `WEBDAV_SESSION_SECRET` 或 `CDN_AUTH_KEY` 提交到 Git。**
4. 公开项目建议定期轮换 WebDAV 密码和两个随机密钥。
5. CDN 下载 URL 属于短期 bearer URL，不要把完整 query string 写进公开日志或统计平台。
6. 保持页面 `Referrer-Policy: no-referrer`。
7. CDN 使用“忽略 Query String Cache Key”时，必须同时启用 EdgeOne Token 鉴权。
8. 如果 WebDAV 不支持 Range，CDN 分片回源效果会降低。
9. WebDAV 地址、账号、密码改变后，建议重新部署并清理旧 CDN 缓存 / 等待旧版本 URL 淘汰。

---

## 15. 常见问题

### 前端为什么没有账号密码输入框？

因为当前版本是固定后端模式。账号密码由部署者在 Makers 环境变量中配置，访问者只能操作这个固定 WebDAV。

### 环境变量配置后为什么仍提示缺少变量？

确认变量配置在 **Production 环境**，然后重新部署。环境变量变更通常需要新的生产部署才能让所有函数实例使用新值。

### CDN 没启用怎么办？

确认同时存在：

```text
CDN_DOWNLOAD_HOST
CDN_AUTH_KEY
```

只配置域名但没配置 Token 主密钥时，项目不会进入完整 CDN 鉴权模式。

### 下载返回 403？

优先检查：

```text
Makers CDN_AUTH_KEY
=
EdgeOne 123cdn.dasb.cn Token 鉴权方式 D 主密钥
```

两边必须完全一致。

### KV 显示 BYPASS？

说明没有绑定名为 `WEBDAV_KV` 的 KV Namespace，不影响基础功能。

### 分片上传报 `Body has already been read`？

如果日志包含：

```text
TypeError: Body is unusable: Body has already been read
```

说明仍在运行 v2.1 或更旧的前端/函数代码，其中分片接口会对原始二进制 PUT 调用 `request.arrayBuffer()`。请部署 v2.2，并确认浏览器 Network 中分片请求变为：

```text
POST /api/webdav/upload/chunk
Content-Type: application/json
```

而不是旧版：

```text
PUT /api/webdav/upload/chunk?uploadId=...&index=...
Content-Type: application/octet-stream
```

如果重新部署后浏览器仍发 PUT，请清除浏览器缓存/CDN 静态缓存或强制刷新页面，确保加载的是新版 `app.js`。
