#!/usr/bin/env node
/**
 * 假 claude 二进制(设计文档 §10 M2:「带假 claude 二进制测试,不碰真 CLI」)。
 * 按 claude -p --input-format stream-json --output-format stream-json 的会话形状
 * 打印录制片段;流式输入模式:首条 prompt 与用户插话都从 stdin 读(user 消息行)。
 * 环境变量控制行为:
 *  - FAKE_CLAUDE_ARGS_FILE: 把收到的 argv 写入该文件(断言白名单/红线缺席)
 *  - FAKE_CLAUDE_STDIN_FILE: 把消费到的 stdin 行(JSON 数组)写入该文件(断言 prompt/插话送达)
 *  - FAKE_CLAUDE_AWAIT_INTERJECT=1: 输出常规流后等第二条 stdin 行(插话,8s 超时);
 *    收到则回显 assistant 文本并在 result 里附 INTERJECTED 标记(测中途插话注入)
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

const stdinFile = process.env.FAKE_CLAUDE_STDIN_FILE;
const awaitInterject = process.env.FAKE_CLAUDE_AWAIT_INTERJECT === '1';
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT || 0);

const prBody = process.env.FAKE_CLAUDE_NO_ACTION === '1'
  ? '核实完毕:该 Issue 已被上游修复,无需改动。\n\n```no-action\n{"reason":"already_fixed","evidence":"修复 commit d9bef57b8f(PR #52261)经 git merge-base 验证已在当前基线;复现测试矩阵(2^53+1/max int64/max uint64)全部通过,无精度丢失。"}\n```'
  : process.env.FAKE_CLAUDE_NO_PR === '1'
  ? '完成,已本地 commit。'
  : '完成,已本地 commit。\n\n```pr-final\n{"title":"fix: 采样参数越界校验","body":"关联 #12345\\n\\n增加温度参数范围校验,补充单测。"}\n```';

// ---- stdin 逐行消费(流式输入:首条 prompt / 后续插话都是 user 消息行) ----
const consumedLines = [];
const pendingLines = [];
const lineWaiters = [];
let stdinBuf = '';
let stdinEnded = false;

function pushLine(line) {
  consumedLines.push(line);
  pendingLines.push(line);
  const w = lineWaiters.shift();
  if (w) w();
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    pushLine(stdinBuf.slice(0, nl));
    stdinBuf = stdinBuf.slice(nl + 1);
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  while (lineWaiters.length) lineWaiters.shift()();
});
process.stdin.on('error', () => {});

/** 等下一条 stdin 行;超时/EOF → null(不卡死) */
function waitLine(timeoutMs) {
  return new Promise((resolve) => {
    if (pendingLines.length) return resolve(pendingLines.shift());
    if (stdinEnded) return resolve(null);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const i = lineWaiters.indexOf(waiter);
      if (i >= 0) lineWaiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    const waiter = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(pendingLines.length ? pendingLines.shift() : null);
    };
    lineWaiters.push(waiter);
  });
}

/** user 消息行 → 文本(stream-json 契约;解析失败回落原文) */
function userText(line) {
  try {
    const o = JSON.parse(line);
    const t = o?.message?.content?.[0]?.text;
    return typeof t === 'string' ? t : line;
  } catch {
    return line;
  }
}

async function run() {
  // 首条 prompt(流式输入模式:prompt 不在 argv,经 stdin 送入)
  await waitLine(5000);

  const lines = [
    { type: 'system', subtype: 'init', model: 'fake-claude-1' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'sampling_params.py' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '定位到校验分支,开始修复。\n(第二行不进摘要)' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest tests/test_sampling.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '1 passed' }] } },
  ];
  for (const l of lines) console.log(JSON.stringify(l));

  let interjected = '';
  if (awaitInterject) {
    const inj = await waitLine(8000);
    if (inj !== null) {
      interjected = userText(inj);
      console.log(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `收到插话:${interjected}` }] } })
      );
    }
  }

  if (process.env.FAKE_CLAUDE_NO_RESULT !== '1') {
    if (process.env.FAKE_CLAUDE_BAD_RESULT === '1') {
      console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: '达到最大轮次', is_error: true }));
    } else if (exitCode === 0) {
      const result = interjected ? `${prBody}\nINTERJECTED:${interjected}` : prBody;
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result, is_error: false, num_turns: 4 }));
    }
  }
  if (stdinFile) writeFileSync(stdinFile, JSON.stringify(consumedLines.map(userText)));
  console.error(process.env.FAKE_CLAUDE_STDERR || 'fake-claude stderr 备注');
  process.exit(exitCode);
}

if (sleepMs > 0) setTimeout(run, sleepMs);
else void run();
