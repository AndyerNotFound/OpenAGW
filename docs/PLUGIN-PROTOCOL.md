# OpenAGW 插件协议 v2

> 参考实现：`ai-gateway-core/src/plugins.js`（OpenAGW client 的原生后端）。
> 本协议只搬"插件内核 + 原生客户端入口"，不搬业务插件与用户体系。
> 状态：内核、意图验签、bootstrap 已落地（`plugins.js` / `plugin-security.js` / `bootstrap.js`）；
> 管理端 API 与 `/admin/ui/<page>` 路由尚未落地，见文末「未完成」。

## 1. manifest.json

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `id` | string | 事实必填 | `^[a-z0-9][a-z0-9-]*$`；缺省取目录名；非法则整个插件被跳过 |
| `type` | `auth`\|`business`\|`theme` | 否 | 缺省 `business` |
| `hasServer` | bool | 否 | 为真且存在 `server.js` 才执行；缺文件则插件被拒 |
| `permissions` | string[] | 否 | 运行时门控；未声明即调用被拒。`gateway:config` 才能读实例配置/渠道/别的插件配置 |
| `provides` | string[] | 否 | **静态意图**，只下发，不参与判断 |
| `appUi` | object | 否 | App 槽位：`personal`/`home`/`bottomBar`/`settings`/`pages`/`widgets` |
| `adminApi` | string[] | 否 | 允许被管理端代调的路径前缀，必须 `/` 开头；`null` = 禁止 |
| `configSchema` | array | 否 | 设置表单 schema |
| `scope` | `global`\|`instance` | 否 | 配置落盘范围，缺省 `global` |
| `dataScope` | `global`\|`instance` | 否 | 数据落盘范围，缺省 `instance`；`global` 的能力额外挂到全局层 |
| `depends` | string[] | 否 | 激活顺序依赖（fail-soft：缺失依赖只记日志，不阻断） |
| `theme` | object | 主题必填 | `{name, dark, light, cssVars, default}` |
| `userPage` / `adminPage` | string | 否 | 旧式 HTML 页路径（保留兼容） |
| `builtin` | bool | 否 | 内核自带标记，只影响展示 |

**主题插件是纯令牌包**：声明 `hasServer`、声明 `permissions`、缺少 `theme` 三者任一即整插件被拒（`plugins.js:normalizeManifest`）。

## 2. ctx（插件上下文）

| 成员 | 说明 |
|---|---|
| `id` / `uid` / `instanceName` / `type` | 插件 id、实例、实例名、类型 |
| `config` | 本插件在本实例的配置 |
| `getPluginConfig(id)` | 读同实例其他插件的配置，无则 `null` |
| `getInstanceConfig()` | 实例配置，掩码密钥、剔除 `_` 前缀键 |
| `registerRoute(method, path, handler)` | 端点 `/plugins/<id><path>`，handler `(req,res,params)` |
| `data.get/set/del/all/flush` | 插件私有 KV，30s 自动落盘 |
| `dataDir` | `data/plugins-data/<inst>/<id>/` |
| `cron(ms, fn)` / `cron(name, ms, fn)` | 定时任务，停用即清 |
| `hook(name, fn)` | 管线钩子（保留） |
| `provideCapability(name, impl)` / `requireCapability(name)` / `listCapabilities()` | 能力注册与查询 |
| `registerAdminUi({id,title,subtitle,icon,menu,render})` | 管理端 SDUI 页，需 `gateway:adminUi` |
| `bindAuthApis({findKey, grantQuota, ...})` | auth 插件向整实例发布认证接口 |
| `security.verifyIntent(req, params)` | 验签，返回 `{ok,keyRecord,_pending}` / `{ok:false,status,error}` |
| `security.guard(req, res, params)` | 验签失败直接写响应并返回 `null` |
| `security.commit(v, response)` | 成功后记录 seq/nonce/幂等响应 |
| `gateway.findKey(token)` / `grantQuota(keyId, tokens)` | 卡密查询 / 加额度（后者需 `gateway:grantQuota`） |
| `log(...)` | 带插件 id 前缀的日志 |

`params` = `{query, body, rawBody, headers, token}`；`token` 依次取 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`?key=`。

## 3. 分发

1. 白名单放行 `/plugins` 与 `/plugins/`，其余前缀仍 404。
2. `p.split('/')` → `segs[1]` 为插件 id → 子路径 `/` + 其余段。
3. 查 `active.get(<inst>/<id>)`，未启用 → `404 {error:"插件未启用: <id>"}`。
4. 命中 `registerRoute` 的 `METHOD 子路径` → 交给 handler，异常 → `500 {error:"插件内部错误: ..."}`。
5. 未命中 → 静态文件回落（`path.normalize` 后必须仍在插件目录内，否则 403），再没有 → 404。
6. `GET /plugins`：`Accept: text/html` 给插件中心页，否则 JSON 列表。

**静态面**：只放 `pages/*.html`、声明的 `userPage/adminPage/icon` 与图片字体（png/jpg/svg/webp/ico/woff/woff2/ttf/otf/eot/css/wasm/txt）；`*.js/*.json/*.md/*.map` 一律 404（不泄露插件源码与端点）；`adminPage` 需要管理端凭据；路径比较在归一化之后做。

## 4. 数据与隔离

- 数据：`data/plugins-data/<inst>/<id>.json`，30s 落盘，停用与进程退出强制落盘。
- 意图安全记录：`data/plugins-data/<inst>/.gc-security.json`（0600，tmp+rename，每次 commit 立即写）。
- 配置：实例 `config*.json` 的 `plugins[]`，每项 `{id, enable, version, config}`。
- 卸载：`keepData=false` 时连数据一起删。

## 5. 意图签名（OpenAGW client §3）

```
X-GC-Sign = HMAC_SHA256(token, ts \n nonce \n seq \n intentId \n METHOD \n pathname \n sha256(rawBody))
```

校验顺序：凭据 → 头齐全 → ±5 分钟时间窗 → 插件归属（`pathname` 必须含 `/plugins/<id>/`）→ 序列号不回滚 → nonce 不重复 → 验签 → **立即消耗 seq+nonce** → 卡密有效（含 `branches` 实例白名单; 为空 = 全部实例）→ 幂等命中回缓存。

- **消耗时机**：HMAC 通过即落盘 seq/nonce。处理器提前返回（业务 400）也不会让同一份签名再次通过；伪造签名不推高 lastSeq。
- **幂等在验签之后**：靠猜测 intentId 拿不到缓存响应。
- **无卡密实例**拒绝一切意图（没有可签名的凭据，自签请求一律 401）。

- `seq` 必须严格递增；回滚返回 `401 {error, currentSeq}`，客户端据此校正。
- nonce 保留最近 200；幂等缓存 24 小时 / 最多 100 条。
- 卡密明文不落盘，只存 `sha256(token)`。
- **插件里的标准写法**：

```js
ctx.registerRoute('POST', '/checkin', async (req, res, params) => {
  const v = ctx.security.guard(req, res, params);   // 失败已写响应
  if (!v) return;
  if (v.replay) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(v.replay)); }
  const out = { ok: true };
  ctx.security.commit(v, out);
  res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(out));
});
```

## 6. 能力（capabilities）

- `provides` 是 manifest 里的静态意图；`capabilities` 是运行时**真正注册**的事实，两者分开下发。
- `dataScope: global` 的插件，其能力同时挂到全局层，任何实例 `requireCapability` 都能取到；取不到返回 `null`，消费方自行降级。
- 能力实现可带 `api()`，返回端点说明（插件相对路径），随 bootstrap 下发，App 按能力名查端点、不按插件名。
- 停用/卸载自动回收该插件贡献的全部能力与管理页。

## 7. 管理端 SDUI（内核侧）

`registerAdminUi({id,title,subtitle,icon,menu,render})`，需 `gateway:adminUi`。

- 页 id 与内核页同名即接管；同 id 后注册者胜。
- `menu:false` 只作为子页，不进侧栏。
- `render(gw, cfg, q, caps)` 返回 gcui 页 `{gcui:1, title, subtitle?, state?, root}`。
- 内核侧已记录，`adminUiManifest()` 已能生成 `{version:1, pages:[{id,title,subtitle,icon,ui:'/admin/ui/<id>'}]}`；**HTTP 路由 `/admin/ui/<page>` 尚未接**。

## 8. 原生客户端入口

`GET /api/app/bootstrap` 返回（字段与 OpenAGW client `Bootstrap` 对齐，全部可缺省）：

```
{ok, core, appApi, branch, uid, serverInfo, userDebug, layout, branches,
 auth:{cardkey,user,registration}, themes[], plugins[], adminUi, capabilities[]}
```

- 单租户：`uid` 恒为 1，`auth.user=false`，`userDebug=null`。
- `plugins[]` 只列启用且激活成功的插件，带 `sha256`、`permissions`、`provides`、`capabilities`、`appUi`。
- `themes[]` 必有一个 `locked` 默认主题，App 不允许删除。

## 9. 未完成（下一里程碑）

| 缺口 | 说明 |
|---|---|
| `/admin/ui/<page>` 路由 | 插件贡献页的 HTTP 入口，需管理端鉴权 |
| `/admin/api/plugin-call` | 管理页写操作代调，按 `adminApi` 前缀白名单 |
| `/admin/api/{status,server-info,client-config,market/test-mode,audit,settings/admin-key,plugins/:inst,plugin-config}` | App 原生管理页依赖的入口；当前 OpenAGW 的名字不同（`instances`/`plugins-enable`/`plugins-config`） |
| auth 插件链 | `type:"auth"` 的激活顺序已就位，但 OpenAGW 仍用内置 `checkAuth`；卡密登录插件需要 `bindAuthApis` 之外的认证链（`registerAuth`） |
| 业务插件 | 22 个参考插件已迁 3 个（balance / probe / legacy-import，见 `src/` 兼容层与 `test/plugins_migrated_test.js`）；余下按缺口分组：hook 管线（record/redact/thinking-summary/pricing-model/billing）、pickChannels+registerExtraEndpoint+saveInstanceConfig（model-sync/openai-extras/proxy）、auth 链+registerTopRoute（auth-cardkey/auth-user/second-auth/auth-adminkey）、事件总线 emit/on+configRev（i18n）、ctx.gcui（model-square/vault/tunnel/music-remote） |

---

## 10. 密钥角色系统（v2.1）

**设计**：一 Key 一权。密钥分两档 `role: "admin" | "user"`。旧卡密无 `role` 字段视为 user。

| 角色 | 聊天 /v1/* | 插件用户端 | 管理 API | 面板 |
|---|---|---|---|---|
| `user` | ✓ 受 `quotaTokens`/`expiresAt`/`rpm`/`tpm`/`models`/`channels`/`branches` 约束 | ✓ | ✗ 401 | ✗ |
| `admin` | ✗ 403 "管理员密钥不能用于 API 访问" | ✗ | ✓ Bearer / x-agw-token / ?key= 均可 | ✓ 登录页填入卡密 + 二次验证(若已开启) |

- **管理层不能用用户 key 进管理面**：`checkAdminAuth` 只认 `role="admin"` 的 `apiKeys`，不认 user key。
- **面板入口**：`/<sid>/admin/<token>`（`agw web login` 打印）。一次性链接只负责打开登录页，登录页要求管理员卡密；实例有卡密或二次验证时，会话必须经过登录页（`login:true`），旧式/待登录会话访问面板与管理 API 一律 401。无 Cookie/Token 访问管理端点 401，sid/token 不匹配 404。
- **管理员 key 不能聊天**：`checkAuth` 看到 `role="admin"` 返回 403，即使 `quotaTokens` 设为 0 也不能绕过。
- **发卡与改权**：`POST /admin/api/keys/:inst` 接受 `role`、`rpm`、`tpm`、`models`、`channels`、`branches`；`POST /admin/api/keys-update/:inst` 可改，`resetRate: true` 清空限流窗口。
- **跨实例**：卡密归属发卡实例；`branches` 为空时不限制实例，非空时仅可使用列出的实例（发卡实例也需列出才能用）。额度、用量与限流窗口都记在发卡实例上。
- **单实例同步**：`hotReload()` 在单实例模式会自动把磁盘上的 `apiKeys` 同步到内存，新密钥立即生效。
