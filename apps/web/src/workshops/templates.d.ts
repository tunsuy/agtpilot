/**
 * 工坊 .md 模板模块声明:import prompt from './prompt.main.md'
 * 得到文件全文字符串(webpack asset/source / vitest load 插件同语义)。
 */
declare module '*.md' {
  const content: string;
  export default content;
}
