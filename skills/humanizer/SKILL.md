---
name: humanizer
description: 去除 AI 写作痕迹，让文本读起来像人写的。基于 Wikipedia《Signs of AI writing》的 26 种痕迹清单。适用于所有内容工坊的成稿后自查与改写。
---

# Humanizer · 去 AI 化写作自查

## 用途

对已生成的文本进行去 AI 化检查与改写，消除 AI 写作痕迹，让内容读起来像人写的。  
适用于公众号、小红书、知乎、微博、视频脚本等所有内容工坊的成稿后自查。

## 工作流

1. **标记**：按 26 种痕迹清单逐项检查文本，标出所有发现的 AI 痕迹（按强度排序）
2. **草拟**：不固定原文结构，重新起草去 AI 版本
3. **自查**：检查草稿是否还有 AI 痕迹，修正
4. **输出**：输出最终版本

## 26 种 AI 痕迹清单

### A. Staging instead of stating（编排而非陈述）

| # | 痕迹 | Before | After |
|---|------|--------|-------|
| 1 | **Not X but Y** | "It's not just X, it's Y" / "This doesn't mean X. It means Y." | 直接陈述观点 |
| 2 | **一句话收尾** | "That is the real win." / "This shows the importance of..." | 删掉重复或解释的收尾 |
| 3 | **听起来深刻的格言** | "At its core, what matters is..." / "Symmetry is the language of trust" | 替换为具体主张 |
| 4 | **Staged run-up** | "Let's dive in" / "Honestly? It depends..." | 删掉 run-up，直接陈述 |
| 5 | **和无人争辩** | "This isn't mainly about..." / "A tempting approach would be..." | 删掉未提出的反对意见 |

### B. Rhythm by rule（规则化节奏）

| # | 痕迹 | Before | After |
|---|------|--------|-------|
| 6 | **强制三连** | "innovation, inspiration, and insights" | 用意义需要的数量 |
| 7 | **重复句首** | "She noted... She noted... She filed..." | 合并或改变主语 |
| 8 | **破折号泛滥** (弱) | "institutions—not the people—yet this continues—" | 用句号/逗号/冒号/括号 |
| 9 | **堆叠限定词** (弱) | "could potentially possibly be argued" | 只保留来源支持的限定词 |
| 10 | **连字符对泛滥** (弱) | "the report is high-quality" | 名词前保留，其余去掉 |
| 11 | **被动语态/缺失主语** (弱) | "No configuration file needed" | 有助时点名执行者 |

### C. Inflation and borrowed authority（夸大与借用权威）

| # | 痕迹 | Before | After |
|---|------|--------|-------|
| 12 | **AI 高频词** | delve / testament / landscape / showcasing / pivotal | 用普通词 |
| 13 | **夸大意义** | "marking a pivotal moment" / "continues to thrive" / "The future looks bright" | 保留事实，去掉意义；以最后一个具体事实结尾 |
| 14 | **模糊关联** | "associated with the leadership of" / "in connection with" | 陈述来源给出的关系 |
| 15 | **浅层 -ing 从句** | "symbolizing... reflecting... showcasing..." | 只保留来源支持的内容 |
| 16 | **销售语言** | "nestled within the breathtaking region" | 陈述事物是什么 |
| 17 | **借用权威** | "Experts believe..." / "cited in NYT, BBC, FT" | 点名真实来源和其说法，或删掉 |
| 18 | **避免 is/are/has** | "serves as... features... boasts" | "is... has" |

### D. Formatting by rule（规则化格式）

| # | 痕迹 | Before | After |
|---|------|--------|-------|
| 19 | **粗体装饰** | "**OKRs**, **KPIs**" / "**Performance:** Performance improved" | 去掉粗体；把标签列表转成散文 |
| 20 | **装饰性标题** | "Strategic Negotiations And Partnerships" / "🚀 Launch Phase:" | 句首大写；去掉 emoji 和箭头；命名章节内容 |
| 21 | **花引号** (弱) | `said "the project"` | `said "the project"` |

### E. Leftovers from chat and draft（聊天与草稿残留）

| # | 痕迹 | Before | After |
|---|------|--------|-------|
| 22 | **聊天残留** | "Great question! ... I hope this helps!" | 删掉包装，保留内容 |
| 23 | **知识局限免责声明** | "While details are limited in available sources, it appears..." | 陈述来源显示的内容，或删掉 |
| 24 | **标题重复** | "## Performance" + "Speed matters." | 让标题发挥作用 |
| 25 | **写文档而非主题** | "This function was added to replace..." / "compiled from..." | 描述主题；仅当读者无法看到时才陈述惯例 |

### F. Writing for the wrong reader（为错误的读者写作）

| # | 痕迹 | Before | After |
|---|------|--------|-------|
| 26 | **重复解释读者已知的内容** | 回复中先走一遍诊断再证明计划有效，然后才给决定 | 以决定开头；诊断和证明留给后续工单 |

## 强制检查清单

成稿后逐项自查，出现任一条即重写该段：

- [ ] 没有 "Not X but Y" 句式
- [ ] 没有一句话收尾或戏剧性片段
- [ ] 没有 "At its core..." / "Let's dive in" / "Honestly?" 等 staged run-up
- [ ] 没有和无人争辩的句式
- [ ] 没有强制三连
- [ ] 没有重复句首
- [ ] 没有破折号泛滥
- [ ] 没有堆叠限定词
- [ ] 没有 AI 高频词（delve, testament, landscape, showcasing, pivotal, leverage, foster, underscore）
- [ ] 没有夸大意义（pivotal moment, continues to thrive, future looks bright）
- [ ] 没有模糊关联（associated with, in connection with）
- [ ] 没有浅层 -ing 从句（symbolizing, reflecting, showcasing）
- [ ] 没有销售语言（nestled, breathtaking, vibrant）
- [ ] 没有借用权威（Experts believe, studies show）
- [ ] 没有避免 is/are/has（serves as, features, boasts）
- [ ] 没有粗体装饰
- [ ] 没有装饰性标题（emoji、箭头、全大写）
- [ ] 没有聊天残留（Great question, I hope this helps）
- [ ] 没有知识局限免责声明
- [ ] 没有标题重复
- [ ] 没有重复解释读者已知的内容

## 使用方式

### 工坊内注入

本清单由各内容工坊(公众号、小红书、知乎、微博、视频脚本)在渲染任务 prompt 时自动注入末尾,工坊用户无需任何勾选动作。成稿后按清单逐项自查,出现任一条就重写该段,确认没有 AI 痕迹后再输出最终版本。

## 来源

- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
- [blader/humanizer](https://github.com/blader/humanizer) — Claude Code skill，MIT 许可
- [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) — 中文版

## 红线

- 不改变原文的事实、数据、引用
- 不编造缺失的信息；如果句子需要一个缺失的细节，询问而不是发明
- 技术/参考文本保持中性和平实
- 个人写作保留作者的观点和怪癖
- 目标是让文本读起来像人写的，不是绕过 AI 检测器