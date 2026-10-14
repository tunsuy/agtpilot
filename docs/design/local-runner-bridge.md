# 本地 Runner 桥接设计(T1:借力本地 coding agent CLI 完成贡献闭环)

- 日期: 2026-10-13
- 状态: **定稿**(§12 全部决策项已于 2026-10-13 由负责人拍板;按 §10 里程碑 M1→M4 排期开工)
- 进度: **M1 已落地**(2026-10-13):`packages/protocol/src/runner.ts`(35 测)、`/api/runner/{pair-code,pair,devices,tasks,events}` 路由、`apps/web/src/lib/runner-bridge.ts`(18 测)、`apps/runner` 骨架 pair/start 心跳/status(20 测)、设备页 `DevicesView`;npm org 注册 + 占位发布待负责人提供 npmjs 账号后进行
- 进度: **M2 已落地**(2026-10-13):任务包渲染器 `packages/protocol/src/runner-taskpack.ts`(renderTaskPrompt/renderHandoffPack/extractPrFinal,同源不漂移,12 测);`apps/runner` 执行链 `repo.ts`(clone/fetch+切分支,workspaceRoot 围栏第二道闸)+ `executor.ts`(ClaudeCodeAdapter:spawn `claude -p` + stream-json 流式解析 + 独立复跑验收 + git commit 校验,§6.1 固化白名单/禁用清单,永不传 `--dangerously-skip-permissions`)+ `task-run.ts`(领取→running→phase1_result→awaiting_approval 事件编排)+ bin start 接 claim(51 测,含**假 claude 二进制 fixture** `test/fake-claude.mjs` 测成功/超时/失败/max_turns/无产出/验收不过,不碰真 CLI);web 机会卡「派发到本地」弹窗 `DispatchRunnerModal.tsx` + 「复制交接包」T0 兜底 + 任务状态徽章回流 `/api/runner/tasks/mine`(runner-dispatch 9 测)
- 进度: **M3 已落地**(2026-10-13):审批闭环(§6.2)—— 协议 `runner-publish.ts`:FrozenCommand/RunnerApproval/RunnerDeviceAction + `buildPublishCommands`(批准时刻固化 git push/gh pr create/可选 gh issue comment,决策项 6 认领留言勾选)+ `validatePublishCommand`(三种**完整形状**白名单:换序/追加参数/缺参/非字符串/控制字符/非 GitHub URL 全拒)+ `extractPrUrl`(11 测,含注入畸形命令拒绝用例);云端 `runner-bridge` 审批单持久化(tasks.json,审批的持久真相;agent-backend 卡片是内存态):createPublishApproval(幂等,快照 PR 终稿优先/diffstat/测试尾部)→ runnerApprovalToRequest(action `runner_publish` dangerLevel high,复用既有 SSE 审批卡 + Web Push 链路,§8)→ resolvePublishApproval(批准:固化命令集落盘 + 任务 finishing;拒绝:rejected,cancel 指令下行,runner 上报 cancelled 落终态、本地分支保留)→ getDeviceActions(状态推导、幂等重发,只下发绑定设备)+ listPendingRunnerApprovalRequests(服务重启后 /api/agent/state 拉取时重灌卡片);agent-backend:registerRunnerApproval(silent 重灌不广播)+ submitApproval 的 runner_publish 分支(裁决失败也撤卡,不留死卡)+ Web Push 归属修正(事件自带 userId 优先于 activeMission);专用高危审批卡 `RunnerPublishApprovalCard.tsx`(PR 终稿/commit/diffstat/测试尾部折叠 + 固化命令原文预览 + 认领留言勾选,桌面驾驶舱与手机同一组件,细节不缩水);runner `publish.ts`:执行前每条命令再过白名单(一条不合法**整组拒绝**并上报)、顺序逐字执行失败即停(超时 5 分钟/条)、gh 输出提取 PR 链接 → phase2_result+done / error+failed 事件编排,bin tick 先处理审批动作再领新任务(63 测)。事件路由 M3 接线:awaiting_approval → 建审批单+注册卡片;done → PR 链接 Web Push
- 进度: **M4 已落地**(2026-10-13):硬化 —— runner `redaction.ts`(§5.3:已知密钥形态正则库 GitHub/AWS/Slack/OpenAI/Anthropic/Google/npm/Stripe/JWT/Bearer 头/URL 内嵌凭据/key=value + PEM 私钥块 + 本机 deviceSecret 值黑名单 + 深度递归 payload,接线在事件出本机唯一出口 client.postEvents;21 测含正常任务文本不误伤用例)+ `event-queue.ts`(§3.1 离线队列:outbox.json 0600 原子写、TTL 7 天与云端任务过期对齐、容量 2000 保最新、eventId 去重、损坏自愈;ReliableEventPoster 包装 postEvents 保持签名/抛错语义,task-run/publish 零改动接入;11 测)+ `audit.ts`(§7 本地 append-only JSONL:paired/start/exit/stop/task_claimed/task_result/publish_cmd 逐条留痕(argv 截断)/publish_result/action_cancel,写失败静默、超 5MB 轮转保后半;logs 子命令 --tail/--json)+ `pidfile.ts`(start 单实例检查 + stop 子命令 SIGTERM→有界等待→清理,死 pid 陈旧自愈;9 测)+ bin 全接线(pair/start/status/stop/logs/config 六子命令齐)+ executor tree-kill(claude 以 detached 进程组起,超时按组 SIGTERM→5s→SIGKILL,§7 资源围栏补齐)+ 安装脚本 `scripts/install.sh`(仓内开发者路径:Node≥20/tsx/claude 检测,生成 ~/.local/bin/agtpilot-runner 包装命令;npm 正式渠道待 org 注册)+ README 全量使用说明。**修复潜在运行时断裂**:packages/protocol 补 `"type": "module"`(此前 tsx 直跑 bin 时 barrel `export *` 被按 CJS 处理,ESM 具名导入解析失败;vitest 自有转换层掩盖了该问题,M4 冒烟 bin 全子命令时暴露)+ bin 全子命令冒烟通过。runner 套件 63→**109 测**;§10 M4 门禁(redaction 用例库/事件幂等去重——云端 eventId 去重 M1 已测,本地 outbox 去重 M4 补测)达成;决策项 7 按需 diff **暂缓**(依拍板「视真实使用情况再建」,v1 未上线无使用数据)
- 进度: **npm 占位发布完成**(2026-10-13):org 最终确认 `@agtpilot`(账号 marshalts),`@agtpilot/runner@0.0.1` 经 npm staged publishing 上线为 `latest`,真机 `npm install -g` + bin 冒烟通过,发布 token 即用即清;发布构建/后续发版注意事项详见 §9
- 进度: **首次真机配对运行**(2026-10-13):web 部署于 `http://agent.tunsuy.cn`(负责人侧),本机 runner `npm i -g` 安装 → pair 成功(设备 dev_af51ee6c5a762154)→ **systemd 系统服务常驻**(`/etc/systemd/system/agtpilot-runner.service`:开机自启、崩溃 5s 重启、600s 内连续失败 5 次熔断、日志进 journal;心跳 sleep 改信号可唤醒,停止毫秒级)。**真机暴露并修复 3 个 bug(全部并入 0.0.2)**:① bin.ts 心跳循环 deps 漏传 sleep,第一拍后崩溃(540682c;M4 冒烟在未配对态跑 start 未进循环,漏网);② task-run.ts onProgress 对 result 事件误取不存在的 summary(tsc 门禁抓到,改报 isError 标志,合数据最小化,540682c);③ pidfile 交接竞态——旧实例慢退出 finally 无条件 clearPid 误删新实例 pidfile、stopByPidfile 等待超时仍谎报 ok,clearPid 加归属检查 + 超时如实报 kill_failed(49390e5)。**防复发:runner 新增 tsc --noEmit 类型门禁(tsconfig.json,纳入 prepublishOnly),runner 套件 110 测**。**本机运行 0.0.2(本地 tarball 安装);npm registry 上仍是带 bug 的 0.0.1,0.0.2 重发待新 token**。注:agent.tunsuy.cn 暂无 TLS(https 不通),deviceSecret 走明文 http——建议配证书后以 https 重新配对(凭据固化 server URL)
- 进度: **经 fork 派发(无推送权限自动检测)**(2026-10-13,并入 0.0.3):对上游无 push 权限是开源贡献常态 —— ① runner 心跳携带本机 gh **公开登录名**(`gh api user --jq .login`,只查用户名不碰凭据,§7 凭据零上行红线不变;deviceMeta.ghLogin:undefined=旧版未上报/null=已上报未登录);② 派发弹窗自动比对「仓库 owner vs 在线设备 gh 账号」,不匹配时琥珀色提示 + 默认勾选**「自动 fork 后派发」**(显式勾选才 fork;组织成员有直推权限可取消勾选);③ runner 领取 viaFork 任务时幂等 `gh repo fork <upstream> --clone=false`(already exists 等同成功),克隆 **fork 副本**到 `<workspaceRoot>/<ghLogin>/<repo>`,gh 未登录则如实报错不猜;④ phase1_result 回流实探 forkRepo(唯一事实源),批准后 PR head 固化为 `owner:branch` 跨仓形式(base 仍是上游 baseBranch),publish 动作携 forkRepo 让 runner 在 fork 目录执行固化命令(`git push -u origin <branch>` 形状不变,origin=fork);⑤ 冻结命令白名单新增 head 的恰一冒号 `owner:branch` 形状校验(owner 段 GitHub 登录名规则,base 位仍拒冒号);审批卡与手机同卡展示「经 fork xxx,PR 指向上游」。fork 内容 = 上游公开仓副本,零本地数据外发;推代码/PR 仍逐条过 Phase 2 审批门。门禁:protocol 66 / runner 125(+tsc)/ web 610(+tsc)/ core 92 / plugin-skill 44 全绿
- 进度: **派发时指定设备**(2026-10-13,负责人拍板补上 §4 承诺的设备选择):派发弹窗设备区从只读展示改为**可选择**(默认第一台在线设备;离线/已吊销置灰不可选;无在线设备禁用派发,交接包人工路径不受影响)→ POST /api/runner/tasks 携 deviceId → 任务记录绑定 `targetDeviceId`(bridge 校验:格式 `dev_[0-9a-f]{16}` + 属于当前用户 + 未吊销,否则拒绝入队,不静默降级 FIFO)→ `claimNextTask` 只把「无绑定或绑定到本设备」的 queued 派给轮询设备(存量无绑定任务 FIFO 语义不变);心跳队列概览项携 targetDeviceId,runner 待领计数只算本机可领;fork 自动检测改为按**选中设备**的 gh 账号比对(它才是真正干活/推代码的身份),切换设备时 fork 勾选重置为自动检测。门禁:protocol 66 / runner 126+tsc / web 614+tsc 全绿
- 前置阅读: `docs/design/sandbox-control-hardening.md`(围栏/审批/热更新模式)、`docs/design/workshop-scenario-loop.md`(场景档案)
- 上游背景: 「开源贡献雷达」工坊(commit 980549a)已交付发现与调研环节;本文档补齐「动手」环节

## 1. 背景与决策记录

### 1.1 缺口

贡献雷达能扫出带 Issue 直达链接的机会清单,但认领后的循环(clone → 改码 → 跑测试 → commit → PR)产品没有承接能力。2026-10-13 与负责人对齐了四个候选:

| 方案 | 形态 | 结论 |
|---|---|---|
| A · E2B 云端持久沙箱 | 云端 MicroVM 执行 | **降级为可选补充**(只读验证性质);写操作在云端执行须托管用户 git 凭据,风险与责任不划算 |
| B · 自托管容器层 | 每用户容器 + 持久卷 | **暂缓**;重运维,且负责人已明确不要常驻服务进程(见 sandbox-control-hardening §2 借鉴矩阵) |
| C · 自建本地 runner | 云端派发低级操作,本地执行 | **被 T1 取代**:文件编辑/命令执行/测试/git/权限门,Claude Code 这类本地 coding agent CLI 全部已做好且身经百战,自建等于重造并自背安全审计 |
| **T1 · 薄桥接(本文档)** | 本地薄 runner 接任务 → 调起用户已装的 coding agent CLI(headless)→ 状态/PR 回流 | **负责人选定**(2026-10-13「那就t1」) |

T0(纯手工交接包:卡片一键复制任务包,用户粘贴进本地 claude 会话)不单独排期,降级为 T1 的**离线兜底交互**(§8.3):任务包格式两者共用。

### 1.2 分工哲学

**agtpilot 当调度台,不当施工队**:发现机会(雷达)、调研(GitHub MCP/DeepWiki)、打任务包、追踪进度、审批外发;写代码这段外包给用户本地已装的 coding agent。这与既有三层围栏(发布永远人工 / 对外发送前逐条审批 / 云端只读调研)一脉相承:

- 云端 Agent 对第三方仓库永远只读(雷达红线不变);
- **一切写操作发生在用户自己的机器、用户自己的 git 身份下**;
- **对外可见动作(git push / gh pr create)必须经云端审批门**,审批通过前 runner 拒绝执行。

## 2. 目标 / 非目标

**目标**
1. 驾驶舱(含手机浏览器)一键把贡献机会「派发到本地」,本地 Claude Code headless 自动完成 clone → 改码 → 测试循环;
2. push/PR 走既有审批卡(dangerLevel=high)+ Web Push 通知,批准后 runner 执行**审批时固化的命令集**,PR 链接回流卡片;
3. runner 出站-only(HTTPS 轮询),用户机器零开放端口,云端零新增常驻进程;
4. 数据最小化:默认只上行结构化状态摘要,代码内容与凭据永不上传。

**非目标(v1 不做)**
- 执行中逐工具审批回环(Claude Code 自带权限门承担;云端 canUseTool 级联动列 v2,§6.4);
- 多 coding agent 适配落地(v1 只做 Claude Code,接口留扩展,§6.5);
- 任务并行(v1 runner 单任务串行,队列 FIFO);
- E2B 云端验证环境(方案 A,另文)。

## 3. 架构总览

```
┌────────────────────────── 云端(现有 Next.js web 进程,零新增常驻进程) ──────────────────────────┐
│  驾驶舱 UI(机会卡「派发到本地」/审批卡/设备页)                                                      │
│      │ SSE(既有 /api/agent/events)          ▲ Web Push(既有 /api/push)                          │
│  agent-backend(Mission/ApprovalRequest 既有机制)                                                 │
│      │                                                                                          │
│  runner-bridge 服务(lib,仿 cron-service:user-store 持久化 + secret-box 加密)                    │
│      │   设备注册表 devices.json / 任务队列 runner-tasks.json(每用户)                              │
│  API: /api/runner/{pair,devices,tasks,events,dispatch}(next-auth 会话 或 设备密钥认证)             │
└──────┬───────────────────────────────────────────────────────────────────────────────────────────┘
       │ HTTPS,出站-only,轮询(任务拉取+心跳 ≈5s / 事件批量上行)
┌──────┴─────────────── 用户本地机器 ──────────────────────────┐
│  apps/runner(@agtpilot/runner,bin: agtpilot-runner)         │
│    pair / start / stop / status / logs                       │
│    ├─ 设备密钥 ~/.agtpilot/runner/credentials.json (0600)     │
│    ├─ 任务执行器 ClaudeCodeAdapter                            │
│    │    spawn: claude -p <任务包> --output-format stream-json │
│    │           --allowedTools … --disallowedTools …           │
│    │    (用户自己的 Claude 订阅/凭据,runner 不经手)             │
│    ├─ workspaceRoot 路径围栏(默认 ~/agtpilot-workspace)       │
│    └─ 审计日志(append-only,本地) + 上行 redaction             │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 通信方式决策:HTTPS 轮询,不用 WebSocket

- web 是标准 `next start` 部署,无自定义 server;引 WS 需要新端口/常驻进程,**违背负责人已确认的「不加常驻进程」原则**(sandbox-control-hardening §2);
- runner 在家庭/办公网络后,出站 HTTPS 是唯一零配置可达方向;轮询 3-5s 对「分钟级编码任务」的时延完全够用;
- 云端→前端实时性已由既有 SSE 承担,runner 事件进 agent-backend 后自动获得 SSE + Web Push 全链路;
- 事件上行用批量 POST(断网本地缓冲重发,幂等 eventId 去重)。

## 4. 配对与设备管理

1. 驾驶舱「设备」页点「配对新 runner」→ 云端生成**一次性配对码**(8 位字符,5 分钟过期,绑定当前登录用户);
2. 用户本地执行 `agtpilot-runner pair --server https://<部署地址> --code XXXXXXXX`;
3. runner POST 配对码 + 设备元信息(hostname/platform/版本/**ghLogin 公开登录名**)→ 云端核销配对码,生成 `deviceSecret`(256-bit 随机):
   - 云端侧:secret-box 加密存 user-store `devices.json`(deviceId/secret 密文/元信息/lastSeenAt/lastSeenIp/状态);lastSeenIp 为云端从配对及心跳请求头(x-forwarded-for/x-real-ip)观察到的来源 IP,随 lastSeenAt 同一 30s 节流落盘,设备页展示排障用(直连无反代时可能缺省;头可伪造,不作鉴权依据);
   - runner 侧:`~/.agtpilot/runner/credentials.json`(0600),含 server URL(配对时固定,防任务来源漂移)+ deviceId + deviceSecret;
4. 后续所有 /api/runner/* 调用带 `X-Runner-Id` + `Authorization: Bearer <deviceSecret>`;
5. 设备页可**吊销**(删除 secret → 轮询 401,runner 本地自毁凭据并提示重新配对);一个用户可配多台(家用台式机/工作机),**派发时选设备**:弹窗设备区单选(仅在线未吊销设备可选,默认第一台在线),任务记录绑定 `targetDeviceId`,只有该设备能领取;无绑定任务(存量/直接调 API 缺省)保持任意在线设备 FIFO。目标设备校验不通过(不存在/已吊销/非本用户)→ 拒绝入队,不静默降级。

安全注记:配对码短有效期 + 云端 UI 展示待配对设备 hostname 供人工确认(防配对码钓鱼);deviceSecret 泄露的影响面 = 该设备可拉取该用户任务并伪造事件,**不能**读历史任务内容(事件下行只含新派发),且可一键吊销。

ghLogin 注记:runner 每次心跳顺带上报 `gh api user` 查到的**公开登录名**(与查 claude 版本同性质,不读取/不缓存/不上传任何 token —— §7 凭据零上行)。三态:`undefined` = 旧版 runner 未上报(云端沿用存量值)、`null` = 已上报但未登录(派发弹窗给 `gh auth login` 指引)、字符串 = 已登录(派发弹窗据此比对仓库 owner,决定是否建议经 fork 派发,§6.1)。

## 5. 任务协议(packages/protocol/src/runner.ts,纯类型+清洗函数,vitest 直测)

### 5.1 任务包(TaskPack,T0 交接包同格式超集)

```ts
interface RunnerTaskPack {
  taskId: string;
  kind: 'oss_contribution';          // v1 唯一类型,协议留扩展
  repo: string;                       // owner/repo
  issueUrl: string;                   // 直达链接(雷达产出)
  baseBranch?: string;                // 缺省 main
  workBranch: string;                 // 如 contrib/oss-radar-<issueNo>
  constraints: string[];              // 只修这个 Issue/不动无关文件/遵循 CONTRIBUTING
  acceptance: { testCommand?: string; note?: string };  // 验收:哪些测试要绿
  claimDraft?: string;                // 认领留言草稿(是否发送由 Phase 2 审批决定)
  prDraft: { title: string; bodyTemplate: string };      // PR 草稿(终稿由本地 agent 按实际改动补全)
  executor: { name: 'claude-code'; maxTurns?: number; timeoutMinutes?: number };
  dispatchNote?: string;              // 用户在派发弹窗里的补充说明(自由文本,进 prompt)
  viaFork?: boolean;                  // 经 fork 派发(派发弹窗显式勾选;runner 克隆 fork 副本,§6.1)
}
```

### 5.2 状态机

```
queued ──派发──▶ dispatched ──runner领取──▶ running(Phase 1)
   │                                          │ 成功:本地 commit 完成、测试绿
   │                                          ▼
   │                              awaiting_approval(Phase 2 审批卡)
   │                                 │批准              │拒绝
   │                                 ▼                  ▼
   └──TTL(默认7天)过期──▶ expired   finishing ──▶ done(PR 链接回流) / failed
                                              │
                                   cancelled(用户撤销,任何非终态可撤)
```

### 5.3 事件流(上行,数据最小化分级)

```ts
interface RunnerEvent {
  eventId: string;                    // 幂等去重
  taskId: string; deviceId: string; at: number;
  type: 'state' | 'progress' | 'phase1_result' | 'phase2_result' | 'error';
  // progress 载荷(默认 standard 档):工具名 + 一行摘要 + 测试尾部 ≤2KB + diffstat
  // minimal 档只发 state;verbose 档(按任务 opt-in)发完整 stream-json 事件
  payload?: Record<string, unknown>;
}
```

**永不上传**:代码文件内容(verbose 档也只传工具事件与 diffstat,不传 diff 正文;「查看 diff」由用户本地看)、任何环境凭据、claude CLI 的会话密钥。runner 上行前过 redaction(已知密钥形态正则 + secret 值黑名单)。

## 6. 两阶段执行(核心安全设计)

### 6.1 Phase 1 · 本地自主干活(无对外副作用)

runner 领取任务后在 workspaceRoot 内执行:

1. **仓库准备**:`git clone`(浅克隆可配)到 `<workspaceRoot>/<owner>/<repo>`,已存在则 fetch + 从 baseBranch 切新分支 —— 由 runner 直接执行(git 命令白名单内),不消耗 agent 轮次;
   **经 fork 派发(pack.viaFork,派发弹窗显式勾选「自动 fork 后派发」)**:先实探本机 gh 登录名(未登录 → 如实报错终止,不猜不降级),幂等 `gh repo fork <upstream> --clone=false`(gh 报 already exists 等同成功),再克隆 **fork 副本** `<ghLogin>/<repo>` 到 `<workspaceRoot>/<ghLogin>/<repo>` —— origin 指向 fork,Phase 2 的 `git push -u origin <branch>` 推的就是 fork,PR 以 `owner:branch` 跨仓形式指向上游(§6.2)。fork 是对外可见动作,但内容 = 上游公开仓的副本、零本地数据,且只发生在用户显式勾选之后;实探到的 forkRepo 随 phase1_result 回流(云端固化 head 的唯一事实源);
2. **调起 coding agent**(用户已装、已登录的 Claude Code,runner 不接触其凭据):

```
claude -p "<按任务包渲染的执行指令>" \
  --output-format stream-json \
  --permission-mode default \
  --allowedTools "Read,Edit,Write,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git add:*),Bash(git commit:*),Bash(git checkout:*),Bash(git branch:*),Bash(<acceptance.testCommand 白名单化>)" \
  --disallowedTools "Bash(git push:*),Bash(gh:*),WebFetch,WebSearch" \
  --max-turns <executor.maxTurns 缺省 60> \
  --add-dir <仓库目录>
```

3. runner 解析 stream-json 事件流 → 映射 RunnerEvent 上行(驾驶舱任务卡实时走 SSE);
4. 终止条件:agent 正常结束且验收命令通过 + 存在本地 commit → 上报 `phase1_result`(diffstat/测试尾部/commit hash/agent 起草的 PR 终稿标题+正文);失败/超时/超轮次 → `failed`(带尾部诊断)。

**红线**:绝不使用 `--dangerously-skip-permissions`;Phase 1 的 allowedTools 里**没有任何产生对外副作用的命令**(push/gh/网络全禁)——即使 prompt 注入劫持了 agent,它能造成的最坏结果局限在本地工作区副本内。

### 6.2 Phase 2 · 对外发送门(必须人工审批)

1. runner 上报 `awaiting_approval` + PR 终稿草稿;
2. 云端创建 **ApprovalRequest**(复用既有机制):`action: 'runner_publish'`, `dangerLevel: 'high'`, params 含 taskId/repo/workBranch/**固化命令集**(如 `git push -u origin <branch>`、`gh pr create --title … --body-file …`,以及是否代发认领留言)+ PR 草稿全文;
3. SSE `approval_requested` → 驾驶舱审批卡;Web Push → 手机收到通知,手机浏览器里批准/拒绝;
4. **批准**:任务进入 `finishing`,下行队列标记 approved(含审批时固化的命令集与 approvalId);runner 下次轮询领取后**逐条执行固化命令集,不重新规划、不追加命令**;任何一条失败即停并上报;成功后 PR URL 回流,任务卡终态 `done`;
5. **拒绝**:任务 `cancelled`,本地分支保留(用户可自行处置),runner 上报确认。

固化命令集是防漂移围栏:审批批的就是执行的,runner 端校验命令前缀白名单(git push/gh pr create/gh issue comment 三类),白名单外一律拒绝执行并上报。

经 fork 派发的固化差异:PR head 固化为 `<forkOwner>:<branch>` 跨仓形式(gh pr create 官方语法;base 仍是上游 baseBranch,gh 从 fork 克隆自动推断 base 仓),白名单对 head 位放行**恰一个冒号**的 owner:branch 形状(owner 段按 GitHub 登录名规则校验,base 位仍拒冒号);publish 动作携 `forkRepo`,runner 在 fork 克隆目录(`<workspaceRoot>/<forkOwner>/<repo>`,仍过路径围栏)执行固化命令,`git push` 形状不变。forkRepo 来源:phase1_result 实探值优先,缺省回退「绑定设备 ghLogin + 仓库名」推算,两头都没有 → head 退回裸分支名(gh 仍可从 origin 推断,只是不如显式确定)。审批卡(桌面/手机同卡)展示「经 fork xxx,PR 指向上游」。

### 6.3 兜底:T0 交接包(离线可用)

任务卡永远带「复制交接包」按钮:把 TaskPack 渲染成十几行 markdown(仓库/Issue 链接/约束/验收/认领留言草稿),用户粘进任意本地 coding agent 会话即可人工走完全程 —— runner 未配对/离线/执行失败时的降级路径,也是 T1 交付前的过渡用法。

### 6.4 v2 备选:执行中审批联动

Claude Agent SDK 的 `canUseTool` 回调(或 PreToolUse hook)可把「执行中要跑白名单外命令」实时推成云端审批,批准后续跑。v1 不做的原因:两阶段模型已覆盖贡献循环的全部对外动作,执行中联动只增加复杂度不增加能力;等真实使用暴露需求再上。

### 6.5 执行器抽象

```ts
interface ExecutorAdapter {
  name: string;
  detect(): Promise<{ installed: boolean; version?: string; loggedIn?: boolean }>;
  run(taskPack: RunnerTaskPack, repoDir: string, onEvent: (e: RunnerEvent) => void): Promise<Phase1Result>;
}
```

v1 仅 ClaudeCodeAdapter;Codex CLI / aider 适配器等接口消费者,协议与审批门完全复用。`detect()` 结果在派发弹窗展示(未装/未登录时禁用派发、给安装指引链接,只检测不代装不碰凭据)。

## 7. Runner 侧围栏与审计

- **路径围栏**:所有文件与 git 操作限 `<workspaceRoot>/<owner>/<repo>` 内(与 plugin-sandbox resolveSafePath 同语义:解析后前缀校验,拒 ../ 穿越与绝对路径逃逸);workspaceRoot 配对时确定、可在本地配置改(改后需云端设备页确认);
- **资源围栏**:任务级 timeout(缺省 30 分钟)+ maxTurns + 子进程 tree-kill;
- **并发**:v1 单任务串行,领取新任务前检查无 running;
- **审计日志**:本地 append-only JSONL(任务/事件/固化命令集/执行结果),`agtpilot-runner logs` 可查;云端侧事件同样落 user-store(既有治理六维框架内);
- **凭据零上行**:git/gh/Claude 凭据全部留在本地原处,runner 代码里不存在读取它们的逻辑(诚实声明:redaction 防的是意外,不读取才是根本)。

## 8. 与现有产品的复用清单

| 复用点 | 现有资产 | 新增 |
|---|---|---|
| 任务来源 | 贡献雷达机会卡(OssOpportunityCard) | 「派发到本地」按钮 + 派发弹窗(选设备/分支名/补充说明/交接包预览) |
| 任务包格式 | 本设计 TaskPack | `packages/protocol/src/runner-taskpack.ts` 渲染器(纯函数,vitest;放协议包而非 web/lib,让 web 交接包预览与 runner 执行指令同源) |
| 任务追踪 | Mission 模型 + mission_updated SSE + 驾驶舱 | runner 任务映射为 Mission 子类,卡片加状态徽章(排队/Runner执行中/待审批/PR已提) |
| 审批门 | ApprovalRequest + /api/agent/approval + 审批卡 | 新 action 类型 runner_publish(高危样式) |
| 手机通知 | Web Push(/api/push,vapid) | awaiting_approval 时触发 |
| 持久化/加密 | user-store + secret-box | devices.json / runner-tasks.json |
| 协议类型 | packages/protocol | src/runner.ts(类型+normalize,纯函数) |
| 云端服务形态 | cron-service.ts(轮询式服务,无常驻进程) | lib/runner-bridge.ts 同款形态 |

## 9. 仓库落位与分发

- `apps/runner`:新包 `@agtpilot/runner`,bin `agtpilot-runner`,子命令 `pair/start/stop/status/logs`;Node ≥ 20,依赖刻意薄(不装 app-kit/cordis —— 它不是 Agent,只是桥);
- `packages/protocol/src/runner.ts`:协议类型与清洗函数(web 与 runner 共同依赖,单一事实源);
- `apps/web`:lib/runner-bridge.ts + /api/runner/* 路由 + 设备页 + 卡片改造;
- 分发(**已拍板 2026-10-13:发 npm**):正式渠道 `npm i -g @agtpilot/runner` 一条命令安装;仓内安装(`pnpm --filter @agtpilot/runner build` + bin 链接)保留为开发者路径。**org 名最终确认 = `@agtpilot`**(负责人 npmjs 账号 `marshalts` 为 owner;曾误建 `@aptpilot`(拼写错,弃用;名下无包,删留均无影响))。**0.0.1 占位发布已完成(2026-10-13)**:走 npm 新版 staged publishing(bypass-2FA granular token 发布 → registry 自动生成 `0.0.0-stage` 占位 → 处理后 `0.0.1` 转正为 `latest`);真机验证 `npm install -g @agtpilot/runner` 成功、安装出的 `agtpilot-runner --help/config` 可跑、`bin → dist/bin.mjs`、零运行时依赖、4 文件 / 解包 62KB。**发布凭据已即用即清**(token 写入 `~/.npmrc` 0600 完成发布后 `rm`,whoami 回到 ENEEDAUTH,无残留)。**发布构建**:`apps/runner/scripts/build.mjs`(esbuild bundle → `dist/bin.mjs`,协议包一并打入、零运行时依赖、不 minify 保持可审计),package.json bin/files/publishConfig(access public)/prepublishOnly(build+test)已配齐。**后续正式发版注意**:npm staged publishing 需要维护者用 `npm stage approve <id>`(本机 npm 10.9.8 无 `stage` 命令,用 `npx npm@12` 或 npmjs.com「Staged Packages」标签页 + 2FA 批准)。
- 版本兼容治理(发 npm 后成为硬约束):runner 在**配对与每次心跳**上报自身版本与协议版本;协议字段只增不改,破坏性变更走大版本号,云端对过旧版本拒绝派发并提示升级命令。

## 10. 里程碑与测试策略

| 里程碑 | 内容 | 测试门禁 | 量级 |
|---|---|---|---|
| M1 协议+配对+在线 | protocol/runner.ts;pair/devices/tasks/events 路由;runner 骨架(pair/start/heartbeat);设备页;npm org 注册 + `@agtpilot/runner` 占位发布(0.0.x 抢名) | 协议 normalize 纯函数测试;路由 vitest(鉴权/配对码过期/吊销 401);runner 单测(假 fetch) | 中 |
| M2 任务包+执行+回流 | 任务包渲染器;卡片「派发到本地」+弹窗;ClaudeCodeAdapter(spawn+stream-json 解析);事件回流→Mission 卡 | 渲染器快照测试;**假 claude 二进制 fixture**(输出录制好的 stream-json,测解析/超时/失败分支,不依赖真 CLI);web 组件测试 | 中大 |
| M3 审批闭环 | awaiting_approval→审批卡+Web Push→固化命令集下行→finishing 执行→PR 回流 | 状态机纯函数全路径测试;固化命令白名单校验测试(含注入畸形命令拒绝用例) | 中 |
| M4 硬化 | 离线队列/TTL/断网重发幂等;redaction;审计视图;交接包兜底按钮;README/安装脚本 | redaction 用例库(密钥形态);事件幂等去重测试 | 中小 |

既有门禁基线(web tsc+vitest / core / plugin-skill)全程保持全绿;runner 包新增自己的 vitest 套件进门禁清单。

## 11. 威胁模型(诚实版)

**能防**
- prompt 注入劫持本地 agent 后对外作恶:Phase 1 工具白名单零对外副作用;push/PR 只有审批固化的命令集能触发,白名单外拒绝;
- 伪造任务/事件:deviceSecret 认证 + server URL 配对时固定 + 每用户队列隔离;
- 配对码钓鱼:5 分钟过期 + 一次性核销 + 云端 UI 展示设备 hostname 人工确认;
- 代码/凭据外泄:数据最小化分级 + redaction + 凭据零上行零读取;
- 跨用户串台:队列/事件/审批全按 userId 归属(既有 SSE 过滤锚点同款);
- 失控执行:timeout + maxTurns + tree-kill + 单任务串行。

**不能防(不夸大)**
- runner 进程在用户机器上被本地恶意软件劫持 —— 同机信任边界,与 sandbox-control-hardening §3 的既有诚实声明一致;
- Claude Code CLI 自身作恶或其权限门被绕过 —— 依赖 Anthropic 的产品安全,我们只保证不 skip-permissions、白名单最小化;
- 用户批准了不该批的审批(审批卡展示 diffstat/测试尾部/命令集原文,降低但不消除误批);
- redaction 正则未覆盖的新型密钥形态(根本缓解仍是「不读取、不上传文件内容」)。

## 12. 决策项(已全部拍板,2026-10-13 负责人)

1. ~~分发~~ **已拍板(2026-10-13 负责人)**:发 npm(`@agtpilot/runner`),仓内安装保留为开发者路径;版本兼容治理与 org 注册见 §9;
2. ~~workspaceRoot 默认值~~ **已拍板(2026-10-13 负责人)**:`~/agtpilot-workspace`(专用隔离,机器人副本与个人工作区分开;配对后可本地改,云端设备页同步确认);
3. ~~v1 执行器~~ **已拍板(2026-10-13 负责人)**:仅 Claude Code,ExecutorAdapter 接口留扩展(§6.5),Codex/aider 等以后按接口加;
4. ~~事件明细默认档~~ **已拍板(2026-10-13 负责人)**:standard(工具名 + 一行摘要 + 测试尾部 ≤2KB + diffstat);minimal/verbose 作为可选项保留;
5. ~~审批通道~~ **已拍板(2026-10-13 负责人)**:产品内审批卡 + Web Push;微信通道是运维侧,不做进产品;
6. ~~认领留言代发~~ **已拍板(2026-10-13 负责人)**:并入 Phase 2 审批,勾选后 `gh issue comment` 进固化命令集;
7. ~~审批卡按需拉取 diff~~ **已拍板(2026-10-13 负责人)**:M4 视真实使用情况再建,v1 不做;若做,拉取指令须绑定 approvalId 且每审批限一次,**阅后即焚、不落盘、不进 Mission 存储**(与 §5.3「代码正文不上行」不冲突:用户显式发起的一次性查看,非默认事件流)。
