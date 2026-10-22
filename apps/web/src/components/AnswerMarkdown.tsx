'use client';

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

export type AnswerSource = { url: string; title: string };

function sameSources(a: AnswerSource[], b: AnswerSource[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.url !== b[i]?.url || a[i]?.title !== b[i]?.title) return false;
  }
  return true;
}

/**
 * 最终答复 markdown 渲染（memo 化，桌面工作台与移动会话共用）。
 * 以 text + 来源列表为比较键：未变化的答复跳过 react-markdown 重新解析，
 * 只有正在流式的那条逐帧解析 —— 消除长会话下的整树 markdown 重解析卡顿。
 */
export const AnswerMarkdown = React.memo(
  function AnswerMarkdown({
    text,
    sources,
    isStreaming,
  }: {
    text: string;
    sources: AnswerSource[];
    isStreaming: boolean;
  }) {
    const index = useMemo(() => new Map(sources.map((s, i) => [s.url, i + 1])), [sources]);
    return (
      <div className="prose prose-zinc prose-chat max-w-none break-words">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            a: ({ href, children }) => {
              const num = href ? index.get(href) : undefined;
              if (num !== undefined) {
                return (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={sources[num - 1]?.title}
                    className="no-underline text-blue-600 hover:text-blue-700 text-[10px] align-super"
                  >
                    [{num}]
                  </a>
                );
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {text}
        </ReactMarkdown>
        {isStreaming && (
          <span className="inline-block w-1.5 h-3.5 bg-zinc-800 animate-pulse ml-0.5 align-text-bottom" />
        )}
      </div>
    );
  },
  (a, b) => a.text === b.text && a.isStreaming === b.isStreaming && sameSources(a.sources, b.sources)
);
