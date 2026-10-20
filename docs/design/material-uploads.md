# 工坊参考资料 · 本地上传文件(material-uploads)

- 日期: 2026-10-20
- 状态: ✅ 已实施(本文与代码一致,可当行为参考)
- 前置阅读: `docs/design/tool-output-spill.md`(read_reference_material 的分页语义)、`apps/web/src/workshops/shared/materials.ts` 头注(数据流总览)

## 1. 背景与决策

工坊「参考资料」原只支持勾选会话交付物(`art_<missionId>`,正文在 mission JSON 里)。负责人 2026-10-20 提出加「本地上传文件」,并拍板:

- 「都做吧」—— 纯文本/代码(A)与 PDF/Word(B)两档都做;
- 「好」—— 存储方案:文件存服务端 `getDataDir()/material_uploads/<safeUserId>/`,与 artifact_files 同布局(按用户分区、路径围栏、原子写、多重上限、上传时即抽取文本),不引任何第三方存储服务。

## 2. 形态

引用命名空间从 `art_*` 扩成两种,prompt 侧语义完全一致(只带 id+标题,正文由 `read_reference_material` 工具按需分页拉取,8000 字/段 + offset 续读):

| 来源 | id 形态 | 正文位置 |
|---|---|---|
| 会话交付物 | `art_<missionId>` | mission JSON 的 artifact.content |
| 本地上传(text) | `upl_<时间36>_<hex16>` | 上传库原件(UTF-8 直读) |
| 本地上传(pdf/docx) | 同上 | 上传时抽取出的 `<id>.txt` |

## 3. 存储与安全(lib/material-uploads.ts)

- 目录:`getDataDir()/material_uploads/<sanitizeSegment(userId)>/`,每条上传三件套:原件 + `<id>.json` manifest + `<id>.txt`(仅 pdf/docx);
- 路径围栏:userId 消毒(只留 `[A-Za-z0-9_.-]`)、uploadId 正则 `^upl_[a-z0-9]+_[a-f0-9]{16}$` 先校验,resolve 后仍须落在库根内;原始文件名只作展示,绝不进路径;
- 原子写:tmp+rename;manifest **最后落盘** —— 半途失败不会留下「列表可见但正文读不出」的条目;
- 四道闸(全部拒收并回显人话错误,不自动淘汰):类型白名单外 / 单文件超限(文本 2MB、pdf+docx 20MB)/ 份数超限(50)/ 每用户总预算超限(100MB,按原件体积);
- 读取按登录用户分区:任何 load/read/delete 都要求 userId 匹配(工具端同源)。

## 4. 类型档位与抽取

- 文本档白名单单一事实源:`workshops/shared/materials.ts` 的 `MATERIAL_TEXT_EXTS`(md/txt/csv/json/log/yaml/html/sql/常见源码后缀),服务端 `lib/material-uploads.ts` import 同一数组,选择器 `MATERIAL_UPLOAD_ACCEPT`(= 白名单 + .pdf + .docx)同源派生,防两处漂移;
- pdf → `unpdf`(getDocumentProxy + extractText mergePages);docx → `mammoth.extractRawText`;两者均为 apps/web 新依赖,默认实现懒加载(动态 import),测试可注入替身(`MaterialExtractors`);
- 抽取发生在**上传时**(一次性成本):失败(损坏/加密)或抽不出文本(扫描件/空文档)当场拒收并给替代路径,不存半残资料;
- `.doc`(旧二进制)、`.pptx`、图片、压缩包一律拒收,错误信息如实说明。

## 5. API 与前端

- `app/api/workshops/materials/route.ts`:GET 列表(新→旧)/ POST multipart 上传(所有拒收 → 400 + 人话 message)/ DELETE `?id=`(不存在 → 404);
- `components/workshops/forms/useMaterialUploads.ts`:客户端 hook(items/loaded/busy/error + upload 串行逐文件 + remove;列表拉取失败静默 —— 选择器仍可用交付物);
- `shared.tsx` DeliverablePicker 增可选 `uploadSection` prop:展开后顶部出现「上传本地文件」按钮 + 限额提示 + 错误回显;上传成功自动勾选;上传条目带 sky 徽章(上传 / 上传 · PDF / 上传 · Word)与删除按钮(先取消勾选再删);
- 三个工坊表单(Content/Zhihu/WechatMp)统一接线:`uploadMaterialOptions(uploads.items)` 排在交付物之前混排,共享 `MATERIAL_COUNT_LIMIT=5`;
- `lib/reference-materials.ts` 解析分支:`UPLOAD_ID_RE` 命中先走上传库(manifest 标题 + 抽取文本),否则走原 `art_`/裸 missionId 路径;工具描述与失败话术同步覆盖两种来源。

## 6. 测试与门禁

- `lib/__tests__/material-uploads.test.ts`:17 例(类型判定/消毒与标题/路径围栏/text 直存直读/用户隔离/空文件/超限/份数 50+1 拒收/pdf+docx 三件套/抽取失败与空文本零残留/删除);
- `lib/__tests__/reference-materials.test.ts`:13 例(原 art_ 8 例不动 + upl_ 解析 3 例 + 上传资料分页/降级/描述 3 例,上传库以 vi.mock 替身隔离落盘);
- `workshops/shared/__tests__/materials.test.ts`:11 例(原 6 例不动 + uploadMaterialOptions 映射/过滤/回退/混排限额 + accept 同源 + 措辞泛化);
- 门禁:apps/web `npx tsc --noEmit` rc=0;全量 web vitest 通过。路由层本仓不做单测(与既有约定一致),库层全覆盖。

## 7. 进度

- 2026-10-20(负责人「都做吧」「好」):全链路落地 —— 存储库 + API 路由 + upl_ 解析分支 + 选择器/三表单接线 + 41 例测试;新依赖 mammoth ^1.13.0、unpdf ^1.9.1;分支 `feat/material-uploads`,PR base=main。
