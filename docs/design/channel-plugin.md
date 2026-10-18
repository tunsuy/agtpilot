# channel 插件设计 —— IM 通道接入(公众号 / 微信个人号 / QQ)

> 目标:用户扫码即可把 AgtPilot 加为"联系人",在微信 / QQ 里直接对话。
> 决策记录:2026-10-18 负责人拍板 —— 微信两条线路都做(公众号 + 个人号),QQ 走 OneBot(NapCat),单独开发一个 channel 插件。

## 1. 通道矩阵

| 通道 id | 平台 | 协议 | 传输方向 | 会话形态 | 凭证 |
|---|---|---|---|---|---|
| `wechat_mp` | 微信公众号 | 平台消息回调(XML) + 客服消息 API | 入站 webhook(app 层持有路由)+ 出站 HTTP | 私聊(openid) | `WECHAT_MP_APPID` / `WECHAT_MP_APPSECRET`(需认证服务号) |
| `wechat_personal` | 微信个人号(iLink 机器人) | 腾讯官方 iLink bot CGI(`ilinkai.weixin.qq.com`) | 纯出站 HTTP 长轮询 | 仅私聊(协议无群概念) | `WECHAT_PERSONAL_BOT_TOKEN`(扫码授权产生) |
| `qq_onebot` | QQ(NapCat / LLOneBot) | OneBot v11 | 出站 WebSocket(forward WS,adapter 主动连 NapCat) | 私聊 + 群聊(@机器人触发) | `QQ_ONEBOT_WS_URL` + 可选 `QQ_ONEBOT_ACCESS_TOKEN` |

合规性说明:
- **iLink 是腾讯官方个人号机器人协议**(`@tencent-weixin/openclaw-weixin` 同款线上协议),扫码授权即得 bot_token,机器人以联系人形态出现在微信会话列表 —— 不是 wechaty/hook 类灰色方案,无封号风险边界内的顾虑。诚实边界:单聊 only、回复须携带来信附带的 `context_token`(冷启动主动私发不可达)、纯文本(item type 1)。
- **QQ OneBot 是非官方协议**(NapCat 挂真实 QQ 号),存在风控风险,负责人知情选择(路线B)。
- 公众号客服消息要求**认证服务号** + 用户 48h 内有互动;不满足时降级为被动回复(仅当轮 5s 内可用,长任务不适用)。

## 2. 复用:@agentoryhq/im-channel-contract

agentory-channels 仓已发布 npm 包(v0.1.0),契约与适配器直接复用,不重造:

- `@agentoryhq/im-channel-contract` —— `ChannelAdapter` / `InboundMessage` / `OutboundReply` / `ChannelAdapterError` / factory 类型。**红线:适配器不得开入站监听**(全部出站长连接/长轮询);**密钥卫生:凭证绝不进错误消息/日志/raw payload**。
- `@agentoryhq/im-channel-wechat-personal` —— iLink 适配器 + 扫码登录助手(`requestWeixinLoginQr` / `pollWeixinLoginStatus`),clean-room 实现,已被 agentory 控制面生产验证。

`wechat_mp` 与 `qq_onebot` 两个适配器在 plugin-channel 内新写,实现同一契约类型。
契约官方测试套件基于 node:test,与本仓 vitest 不合轨 —— 按套件同等语义在 vitest 里落守护用例(身份/ fail-closed / not_started 守卫 / 密钥卫生四组不变量)。

## 3. 分层(铁律对照)

```
apps/web(策略层)                 packages/plugin-channel(能力层)
┌─────────────────────────┐      ┌──────────────────────────────┐
│ channel-service.ts       │      │ ctx.channel(ChannelService)  │
│  · 身份绑定 externalId→userId    │  · attach/detach(adapter)    │
│  · 会话映射 conversation→mission │  · onMessage 扇出(app 注册) │
│  · runMission + 提取答案  │ ───► │  · send 路由                 │
│  · 排队/去重/限流         │      │  · 连接状态表                │
│ api/wechat/callback(MP webhook 归 app 层,解析后 ingest 给插件)│
│ api/channel/*(状态/扫码绑定/绑定码)                           │
│ channel-store(持久化,user-store 同族)                        │
└─────────────────────────┘      │ 适配器:qq-onebot / wechat-mp │
                                  │ 注册表:buildChannelsFromEnv  │
                                  └──────────────────────────────┘
```

反模式 #10(cron/mcp 双轨分裂)的正面应用:**插件是无头通道引擎** —— 只管连接、收发、状态;身份绑定、会话→任务映射、持久化、执行身份全部归应用层。插件不读 `process.env`(凭证由 app 层经 env 对象传入 factory),不 import 任何 app 代码。

内核零改动:channel 不进 `contracts.ts`(无其他插件依赖它),仅按新增插件检查单在 app-kit `mount('plugin-channel', ChannelPlugin)` 一行。不注册工具、不注册路由规则(Phase 1 无 `channel_` 工具;后续若给模型"发消息"能力,按 cron 模式插件留能力、app 层暴露工具)。

## 4. 消息流

```
入站:adapter.onMessage(InboundMessage)
  → ctx.channel 扇出 → channel-service.handleInbound
  → 绑定查询(channel-store):未绑定 → 回绑定指引,结束
  → 已绑定 → 按 conversationId 进串行队列(每会话同时最多 1 个在飞任务)
  → runMission(text, {userId, missionId: 会话映射的 missionId, title})
  → 提取 mission.steps 最后一条 assistant answer
  → ctx.channel.send(channel, {conversationId, text: 答案(截断到通道上限)})

会话续聊:conversationId → missionId 映射持久化在 channel-store;
  「新会话」指令(如 /new)清映射,下一条消息开新 mission。
运行中追问:channel-service 串行化保证不触发 runMission 的排队路径;
  超过 8s 未完成先发「⏳ 处理中」ack(可配),避免用户以为掉线。
幂等:messageId 去重(LRU,防平台重推 —— MP 有 3 次重试语义)。
```

绑定流程(三通道统一):
1. Web 设置页(已登录)→ `POST /api/channel/bind-code` → 6 位绑定码(10min TTL,存 channel-store,code→userId)
2. 用户在 IM 里对机器人发 `绑定 <code>` → channel-service 校验 → 持久化 `{channel, externalUserId} → userId`
3. 之后消息按绑定路由;解绑 `解绑` / Web 端管理。

微信个人号 bot_token 获取(运维流):
- `POST /api/channel/wechat-personal/qr` → 转发 `requestWeixinLoginQr` → 返回二维码内容(web 渲染 / 运维侧转成图片发给负责人扫)
- `GET /api/channel/wechat-personal/qr?handle=` → 轮询 `pollWeixinLoginStatus`(处理 `*_redirect` 换 host 重走)→ confirmed 得 bot_token → 写入 channel-store(不进 .env)→ 热 attach 适配器。

## 5. 适配器要点

### qq-onebot(新写)
- 出站 WS 连 NapCat forward-WS(`Authorization: Bearer <token>` 可选);指数退避重连(1s 起步,30s 封顶),状态翻转经 onStateChange 上报。
- 入站 `post_type=message`:私聊 conversationId=`private:<user_id>`;群聊 `group:<group_id>`,**必须 @机器人**(at 段含 self_id)才发射,否则零发射丢弃(契约归一化规则);昵称取 `sender.nickname`。
- 出站按 conversationId 前缀路由 `send_private_msg` / `send_group_msg`;action 带 `echo` 等回执;文本上限 4000 截断标记。
- 传输注入式设计(`transport` 可替换),vitest 用假 WS 跑收发/重连/归一化,不起真连接。

### wechat-mp(新写)
- **不开监听**:webhook 路由在 apps/web(既有 `api/wechat/callback`,签名校验已实现);路由把原始 XML 交给 `ctx.channel.ingestWebhook('wechat_mp', xml)` → 适配器解析归一化为 InboundMessage。
- 出站客服消息 `message/custom/send`(msgtype=text),access_token 走 `stable_token`(内存缓存,提前 5min 过期,与 web 侧 wechat-mp.ts 同款策略但独立小实现 —— 插件不得 import app 代码)。
- 纯函数(XML 解析/归一化)带 vitest 用例;fetch 注入可测。
- 关注事件(subscribe)由 callback 路由被动回复欢迎语 + 绑定指引,不进 agent。

### wechat_personal(复用 npm 包)
- factory `fromEnv` 直接注册;扫码登录助手在 app 层 API 路由消费。
- 诚实边界照抄包文档:仅私聊、回复型发送(context_token 缓存)、4000 字上限、`ret=-14` → credential_invalid(引导重新扫码)。

## 6. 环境变量(新增)

| 变量 | 默认 | 作用 |
|---|---|---|
| `AGTPILOT_CHANNELS` | 开 | `0` = channel-service 不启动(总闸) |
| `WECHAT_MP_APPID` / `WECHAT_MP_APPSECRET` | 空(通道关闭) | 公众号客服消息凭证;缺省 wechat_mp 不注册(fail-closed) |
| `WECHAT_PERSONAL_BOT_TOKEN` / `WECHAT_PERSONAL_BASE_URL` | 空(通道关闭) | iLink bot 凭证(扫码后写 channel-store 亦可,env 优先) |
| `QQ_ONEBOT_WS_URL` / `QQ_ONEBOT_ACCESS_TOKEN` | 空(通道关闭) | NapCat forward-WS 端点 / 鉴权 token |
| `AGTPILOT_CHANNEL_ACK_MS` | 8000 | 超过该时长未完成先发「处理中」ack;`0` = 关闭 ack |

凭证不全 → factory 返回 null → 通道不注册,**启动永不因通道阻塞**(契约 factory 语义)。

## 7. 部署形态

- 公众号:微信后台把回调 URL 指到本部署 `/api/wechat/callback`(既有),Token 用 `WECHAT_TOKEN`。
- 微信个人号:零公网依赖(纯出站长轮询)。扫码一次即得 token。
- QQ:负责人侧跑 NapCat(docker,挂一个 QQ 号),开 forward-WS 指向 agtpilot 可达地址;`QQ_ONEBOT_WS_URL=ws://<napcat>:3001/onebot/v11/ws`。

NapCat 独立机器部署片段(内存限额按实测 ~1GB 需求配 1.5G;agtpilot 主机只有 1.6G,同机跑会挤爆,故单独一台):

```yaml
# docker-compose.yml —— NapCat(OneBot v11 正向 WS),跑在独立机器
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      - NAPCAT_UID=1000
      - NAPCAT_GID=1000
    ports:
      - "6099:6099"          # WebUI(首次扫码登录 QQ 用,登录后建议防火墙关掉)
      - "3001:3001"          # OneBot 正向 WS 服务器(agtpilot 主动连入)
    volumes:
      - ./napcat/config:/app/napcat/config   # 登录态持久化(丢了要重新扫码!)
    deploy:
      resources:
        limits:
          memory: 1536M
```

NapCat WebUI(默认 `http://<napcat机器>:6099/webui`)里配置 OneBot v11 连接:
正向 WS 是 NapCat 作服务端、agtpilot 作客户端 —— 在 WebUI 新增「WebSocket 服务器」,监听端口 `3001`,设置 access token;agtpilot 侧对应:

```bash
QQ_ONEBOT_WS_URL=ws://<napcat机器IP>:3001/onebot/v11/ws
QQ_ONEBOT_ACCESS_TOKEN=<与 NapCat WebUI 里一致的 token>
```

首次使用在 WebUI 扫码登录机器人 QQ 号;`./napcat/config` 卷保住登录态,重启不掉线。

## 8. Phase 边界(说到做到)

Phase 1(本次):纯文本收发、绑定、会话续聊、三通道注册、状态 API。
不做也不承诺:媒体消息(图片/语音)、群聊多轮话题隔离、主动推送(冷出站)、通道级限流策略、web 设置页 UI(先 API,UI 随后)。README 只写已实现部分(铁律 7)。

## 9. 测试策略

- 纯函数全量 vitest:OneBot 归一化(私聊/群聊@/非@丢弃/CQ 串解析/截断)、MP XML 解析(文本/事件/CDATA/畸形)、绑定码校验、会话映射、env 注册表 fail-closed。
- 契约守护用例(node:test 套件的 vitest 同语义移植):apiVersion/channel/capabilities 身份、无凭证 probe fail-closed 且不 throw、未 start 就 send → `not_started`、错误消息与 raw 不含凭证哨兵值。
- 假传输注入:OneBot 用 fake WS 跑 连接→收→回→断线重连;MP 用 stub fetch 跑 token 缓存/刷新/客服消息发送;不起真实网络连接。
