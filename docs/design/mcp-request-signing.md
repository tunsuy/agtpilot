# MCP 逐请求动态签名扩展点(signRequest)

状态:已实现(方案 a,2026-10-14)
关联:连接器目录 flyai(飞猪)接入;`packages/plugin-mcp`、`apps/web/src/lib/mcp-connectors.ts`

## 1. 问题

部分远程 MCP 端点属于「签名网关型」:除静态凭证头(Authorization / api-key)外,
还要求**每个 HTTP 请求**附一组随请求内容变化的签名头——时间戳、随机 nonce、
对请求体与凭证摘要计算的 HMAC。签名值逐请求不同,无法用「配好就不变的静态
header」表达。

`plugin-mcp` 原 `MCPServerConfig` 只有两条凭证通道:
- `headers`:静态请求头(值固定);
- `authProvider`:MCP 标准 OAuth(SDK 自动附 token + 401 刷新)。

两者都表达不了「每请求现算签名」,因此飞猪这类端点裸接必 401(实测:
`Authorization verification failed`)。

## 2. 目标与非目标

**目标**:给 `plugin-mcp` 增加一个通用、最小的逐请求签名注入点,让任何
「签名网关型 MCP」都能接进连接器体系,复用现成的凭证存储 / 连接器页 UI /
routeWords 路由 / subagentOpen 红线,不必为每家单开框架。

**非目标**:不实现任何一家(含飞猪)的具体签名算法于插件内——算法归 web 侧
纯函数;插件只认「一个把请求映射为附加头的函数」。不把执行面 / 任意脚本
开放给连接器配置(与 plugin-skill 的声明式边界同源)。

## 3. 接口形状

```ts
/** 一次出站 HTTP 请求的快照(签名函数入参) */
export interface SignableRequest {
  method: string;              // 大写,如 'POST' / 'GET'
  url: string;                 // 完整请求 URL(含 path/query)
  body: string;                // 请求体文本;GET/无体 → 空串
  headers: Record<string, string>; // 即将发送的头(键归一为小写),含静态 Authorization
}

/** 逐请求签名钩子:返回要附加/覆盖到本次请求的头 */
export type RequestSigner = (req: SignableRequest) =>
  | Record<string, string>
  | Promise<Record<string, string>>;

export interface MCPServerConfig {
  // ...既有字段...
  /** 逐请求动态签名(http/sse 有效;stdio 忽略)。与 headers 叠加,签名头后置覆盖 */
  signRequest?: RequestSigner;
}
```

`McpServerDef` 侧对应加一个**工厂**字段(吃凭证、吐签名器),由
`serverConfigFromDef` 展开成 `MCPServerConfig.signRequest`:

```ts
interface McpServerDef {
  // ...
  /** 逐请求签名器工厂(token 类:把凭证/密钥闭包进签名器) */
  sign?: (cred: string) => RequestSigner;
}
```

## 4. 实现要点(plugin-mcp)

- MCP SDK 的 `StreamableHTTPClientTransport` / `SSEClientTransport` 均支持
  `fetch?: FetchLike` 自定义实现(`FetchLike = (url, init?) => Promise<Response>`)。
- `signRequest` 存在时,`buildMCPTransport` 传入一个包装 fetch:
  1. 从 `init` 归一出 `method`(缺省 GET)、`body`(字符串化,缺省空串)、
     `headers`(读成小写键快照,供签名器读 Authorization);
  2. `await signRequest({...})` 拿到附加头;
  3. 合并进 `Headers`(签名头覆盖同名静态头),转发真实 `fetch`。
- **为何签名器能看到凭证**:SDK 的 `send()` 在调用自定义 fetch 前,已经用
  `_commonHeaders()` 把 `requestInit.headers`(即静态 Authorization)并入
  `init.headers`;`init.body` 是 JSON-RPC 文本。故包装 fetch 收到的 `init`
  同时含凭证与请求体——正是 HMAC canonical string 所需的全部输入。
- 主链路(initialize / tools/list / tools/call)是纯 POST;GET SSE 仅用于
  断线续传(resumptionToken),签名器对 GET 以空 body 签名,行为一致。
- 重定向:包装 fetch 每次调用都重签,`fetchWithinOrigin` 若跟随同源重定向会
  以新 URL 再签一次——语义正确。

## 5. 安全约束(红线)

1. **凭证零硬编码**:签名算法可含「协议级公共常量」(如飞猪的 signSecret,
   MIT CLI 内置、须与服务端一致、对所有客户端同值),但**用户私有凭证
   (自备 API key / token)一律不入库**,走连接器 token 通道由用户自备。
   - 例外(负责人拍板 2026-10-14「默认公共key 用户配置了用用户的」;后「改吧」= 手动启用):
     连接器可内置**官方公共试用 key**(如飞猪 flyai,官方 MIT CLI 随包公开分发、
     非私有密钥),但**不再对所有人默认常连**,而是卡片「启用公共试用」由用户**手动
     启用**(存哨兵 `'1'`)——避免所有用户共享同一试用身份被限流/吊销。启用后走公共
     试用通道;用户一旦粘贴自有 key 则**一律优先用户的**。规模化应引导用户配自有
     key(见连接器 authHint)。此例外只针对「公开分发的官方试用凭证」,不放宽
     「用户私有凭证不入库」红线。
2. **签名器是纯函数**:无 IO、无副作用、不读 process.env(凭证经闭包注入),
   vitest 直测(含对服务端实测向量做回归)。
3. **不扩执行面**:签名钩子只能产出「附加请求头」,拿不到 fetch/socket 控制权,
   不能改 URL/body/方法——最小权限,与 plugin-skill 声明式边界同源。
4. **subagentOpen 独立判定**:接入签名不改变子 agent 开放红线;涉及实时行情
   数字(机票/酒店价)、按量计费、现实副作用者一律 `false`,锁进 NEVER_OPEN 回归。
5. **URL 安全校验不绕过**:签名 fetch 仍走 `assertSafeUrl`(只允许 http/https、
   封禁云元数据端点),包装发生在 transport 内部,校验在其前。

## 6. 消费方:飞猪 flyai

- 端点:`https://flyai.open.fliggy.com/mcp`(Streamable HTTP,实测 protocolVersion
  2025-03-26,serverInfo `flyai-open/1.0.0`,9 个只读搜索工具)。
- 签名协议(复刻官方 CLI,HMAC-SHA256):
  - canonical = `method \n pathname \n timestampMs \n nonce \n sha256hex(body) \n sha256hex(normalizedAuth)`
  - `normalizedAuth` = Authorization 值(补全 `Bearer ` 前缀;空 → 空串)
  - sign = `base64url(HMAC_SHA256(signSecret, canonical))`
  - 附加头:`x-flyai-sign-ver: 7`、`x-flyai-sign-alg: hmac-sha256`、
    `x-flyai-ts`、`x-flyai-nonce`(16 字节 hex)、`x-flyai-sign`
- `x-ff-ctx`(加密设备指纹)实测**可选**(带/不带均 200),故不采集——
  少一处主机信息采集,契合隐私红线。
- `signSecret` = 协议级公共常量(源码注释标注来源 + 可被 `FLYAI_SIGN_SECRET`
  覆盖)。
- `FLYAI_API_KEY`(用户身份凭证):连接器为 `authType: 'token'` +
  `publicTrial: true`(一键公共试用标记,负责人拍板 2026-10-14「默认公共key 用户
  配置了用用户的」,后「改吧」改为**手动启用**)。**不再对所有人默认常连**:裸用户
  未保存凭证 → `connectedServerDefs` 跳过(不连、不注册工具路由);卡片「启用公共
  试用」按钮把哨兵 `'1'` 存进 `MCP_FLYAI_API_KEY` 完成手动启用,用户也可粘贴自有 key。
  `resolveFlyaiKey(cred)` 收敛凭证(用户 key 优先,空 / 哨兵 '1' → `FLYAI_PUBLIC_TRIAL_KEY`)。
  连接判定(`connectedServerDefs`:非空才连)、UI 状态(`api/connectors/mcp`:哨兵
  '1' 显「公共试用通道」,否则掩码 key)、Agent 就绪判定
  (`connector-bridge.isConnectorConfigured`:非空才就绪)三处一致消费
  `configs[MCP_FLYAI_API_KEY]`,保证「手动启用后才连」在路由/展示/中途授权各链路语义统一。

## 7. 测试

- plugin-mcp:`buildSignedFetch` 单测(mock 签名器 + 假 fetch)——验证签名器
  收到正确 method/body/Authorization、附加头合并覆盖、无 signRequest 时不包装。
- web:flyai 签名纯函数单测——对固定 ts/nonce/body/key/secret 的 canonical 与
  HMAC 做已知向量回归(向量取自对服务端实测通过的请求);`resolveFlyaiKey`
  回退单测(用户 key 优先、空/哨兵 '1' → 公共试用 key)。
- 目录回归:flyai 进 NEVER_OPEN;routing 触发词命中;裸用户**不默认连接**(不注册
  路由)、手动启用(哨兵 '1')后以公共试用 key 直连、用户粘贴自有 key 后
  `buildUserMcpServers` 覆盖为用户 key(Authorization 头断言)。
