#!/usr/bin/env node
/**
 * 假 claude 二进制(设计文档 §10 M2:「带假 claude 二进制测试,不碰真 CLI」)。
 * 按 claude -p --output-format stream-json 的输出形状打印录制片段;
 * 环境变量控制行为:
 *  - FAKE_CLAUDE_ARGS_FILE: 把收到的 argv 写入该文件(断言白名单/红线缺席)
 *  - FAKE_CLAUDE_EXIT: 退出码(默认 0)
 *  - FAKE_CLAUDE_SLEEP_MS: 退出前睡眠(测超时终止)
 *  - FAKE_CLAUDE_NO_PR=1: result 不带 pr-final 围栏
 *  - FAKE_CLAUDE_NO_ACTION=1: result 带 no-action 围栏(agent 核实无需改动的例外终态)
 *  - FAKE_CLAUDE_BAD_RESULT=1: result 为 is_error(max_turns)
 *  - FAKE_CLAUDE_NO_RESULT=1: 不输出 result 事件(流不完整)
 *  - FAKE_CLAUDE_STDERR: 自定义 stderr 内容(测瞬时错误指纹,默认「fake-claude stderr 备注」)
 */
import { writeFileSync } from 'node:fs';

const argsFile = process.env.FAKE_CLAUDE_ARGS_FILE;
if (argsFile) writeFileSync(argsFile, JSON.stringify(process.argv.slice(2)));

const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT || 0);

const prBody = process.env.FAKE_CLAUDE_NO_ACTION === '1'
  ? '核实完毕:该 Issue 已被上游修复,无需改动。\n\n```no-action\n{"reason":"already_fixed","evidence":"修复 commit d9bef57b8f(PR #52261)经 git merge-base 验证已在当前基线;复现测试矩阵(2^53+1/max int64/max uint64)全部通过,无精度丢失。"}\n```'
  : process.env.FAKE_CLAUDE_NO_PR === '1'
  ? '完成,已本地 commit。'
  : '完成,已本地 commit。\n\n```pr-final\n{"title":"fix: 采样参数越界校验","body":"关联 #12345\\n\\n增加温度参数范围校验,补充单测。"}\n```';

function run() {
  const lines = [
    { type: 'system', subtype: 'init', model: 'fake-claude-1' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'sampling_params.py' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '定位到校验分支,开始修复。\n(第二行不进摘要)' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest tests/test_sampling.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '1 passed' }] } },
  ];
  for (const l of lines) console.log(JSON.stringify(l));
  if (process.env.FAKE_CLAUDE_NO_RESULT !== '1') {
    if (process.env.FAKE_CLAUDE_BAD_RESULT === '1') {
      console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: '达到最大轮次', is_error: true }));
    } else if (exitCode === 0) {
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: prBody, is_error: false, num_turns: 4 }));
    }
  }
  console.error(process.env.FAKE_CLAUDE_STDERR || 'fake-claude stderr 备注');
  process.exit(exitCode);
}

if (sleepMs > 0) setTimeout(run, sleepMs);
else run();
