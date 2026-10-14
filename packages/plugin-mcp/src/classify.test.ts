import { describe, it, expect } from 'vitest';
import {
  classifyToolReadOnly,
  heuristicReadOnly,
  tokenizeToolName,
  READ_VERBS,
  DESTRUCTIVE_TOKENS,
} from './classify';

/**
 * default-deny 只读自动分类(spec §4.3 机器钥匙信号扩展)。
 * 红线:失败方向永远偏「少放行」——判不出只读就不带 readOnly,不会误开写工具进子 agent。
 */

describe('tokenizeToolName', () => {
  it('下划线/连字符/点/空格分词 + camelCase 拆分 + 小写', () => {
    expect(tokenizeToolName('search_repositories')).toEqual(['search', 'repositories']);
    expect(tokenizeToolName('searchRepositories')).toEqual(['search', 'repositories']);
    expect(tokenizeToolName('Get-Issue')).toEqual(['get', 'issue']);
    expect(tokenizeToolName('ns.tool.name')).toEqual(['ns', 'tool', 'name']);
    expect(tokenizeToolName('')).toEqual([]);
  });
});

describe('heuristicReadOnly(名称动词启发,注解沉默时才用)', () => {
  it.each([
    'search_repositories',
    'get_issue',
    'list_pulls',
    'fetch_url',
    'query_database',
    'read_file',
    'view_profile',
    'find_users',
    'browse_docs',
    'retrieve_records',
    'lookup_dns',
    'show_diff',
    'describe_table',
    'check_health',
    'get_user_status',
    'count_commits',
    'whoami',
    'listCreatedFiles', // camelCase,首词素 list
  ])('只读动词开头 → 只读:%s', (name) => {
    expect(heuristicReadOnly(name)).toBe(true);
  });

  it.each([
    'create_issue',
    'update_profile',
    'delete_repo',
    'remove_member',
    'add_comment',
    'edit_page',
    'send_message',
    'post_article',
    'submit_form',
    'publish_release',
    'upload_file',
    'merge_branch',
    'cancel_order',
    'run_pipeline',
    'exec_command',
    'deploy_service',
    'install_package',
    'write_file',
    'modify_config',
    'set_value',
  ])('写动词开头 → 拒绝:%s', (name) => {
    expect(heuristicReadOnly(name)).toBe(false);
  });

  it('破坏性动词藏在后面也拒绝(首词素即便只读)', () => {
    expect(heuristicReadOnly('search_and_delete')).toBe(false);
    expect(heuristicReadOnly('list_removed_items')).toBe(false);
    expect(heuristicReadOnly('get_drop_candidates')).toBe(false);
  });

  it('只读工具里出现非破坏性写词的名词形 → 不误伤', () => {
    // comment/create 不是破坏性动词,靠首词素判定;这些首词素是只读动词 → 放行
    expect(heuristicReadOnly('get_issue_comments')).toBe(true);
    expect(heuristicReadOnly('list_created_files')).toBe(true);
    expect(heuristicReadOnly('search_updates')).toBe(true);
  });

  it('拿不准 = 拒绝(default-deny):名词开头 / 含糊动词 / 空名', () => {
    expect(heuristicReadOnly('ask_question')).toBe(false); // deepwiki:靠逃生口,不靠启发
    expect(heuristicReadOnly('repository_search')).toBe(false); // 名词开头
    expect(heuristicReadOnly('process_data')).toBe(false); // 含糊动词
    expect(heuristicReadOnly('handle_event')).toBe(false);
    expect(heuristicReadOnly('')).toBe(false);
  });

  it('READ_VERBS 与 DESTRUCTIVE_TOKENS 无交集(避免自相矛盾)', () => {
    for (const v of READ_VERBS) expect(DESTRUCTIVE_TOKENS.has(v)).toBe(false);
  });
});

describe('classifyToolReadOnly(三级优先)', () => {
  it('① 注解权威:readOnlyHint=true → 只读,basis=annotation(即便名字像写)', () => {
    const r = classifyToolReadOnly({ name: 'delete_everything', annotations: { readOnlyHint: true } });
    expect(r).toEqual({ readOnly: true, basis: 'annotation' });
  });

  it('① 注解权威:readOnlyHint=false → 拒绝,启发式不介入(即便名字像读)', () => {
    const r = classifyToolReadOnly({ name: 'search_repositories', annotations: { readOnlyHint: false } });
    expect(r).toEqual({ readOnly: false, basis: 'denied' });
  });

  it('① 注解权威:destructiveHint=true → 拒绝(压过 readOnlyHint=true)', () => {
    const r = classifyToolReadOnly({
      name: 'get_x',
      annotations: { readOnlyHint: true, destructiveHint: true },
    });
    expect(r).toEqual({ readOnly: false, basis: 'denied' });
  });

  it('② 注解沉默 → 名称启发,basis=heuristic', () => {
    expect(classifyToolReadOnly({ name: 'search_repositories' })).toEqual({ readOnly: true, basis: 'heuristic' });
    expect(classifyToolReadOnly({ name: 'search_repositories', annotations: {} })).toEqual({
      readOnly: true,
      basis: 'heuristic',
    });
    expect(classifyToolReadOnly({ name: 'search_x', annotations: { title: 'Search' } })).toEqual({
      readOnly: true,
      basis: 'heuristic',
    });
  });

  it('③ default-deny:注解沉默 + 名称判不出 → 拒绝', () => {
    expect(classifyToolReadOnly({ name: 'create_issue' })).toEqual({ readOnly: false, basis: 'denied' });
    expect(classifyToolReadOnly({ name: 'ask_question', annotations: undefined })).toEqual({
      readOnly: false,
      basis: 'denied',
    });
  });

  it('非 boolean 的 hint 不算服务器表态 → 落回名称启发', () => {
    expect(classifyToolReadOnly({ name: 'list_x', annotations: { readOnlyHint: 'true' } })).toEqual({
      readOnly: true,
      basis: 'heuristic',
    });
  });
});
