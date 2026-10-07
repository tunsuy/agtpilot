import * as fs from 'fs';
import * as path from 'path';

/**
 * 用户级别数据持久化隔离存储引擎 (User Scoped Data Store)
 * 每个用户独占自己的数据空间，包含：
 * - 连接器 API Key 与环境变量配置 (connectors)
 * - 个人长效记忆与画像 (memories)
 * - 主动巡航定时任务 (cron jobs)
 * - 执行会话历史任务 (missions)
 */

export interface UserScopedData {
  userId: string;
  connectors: Record<string, string>; // envVar -> value
  activeModelId?: string;
  memories: any[];
  cronJobs: any[];
  missions: any[];
  goals?: any[];
  updatedAt: number;
}

export function getDataDir(): string {
  // 1. 优先读取显式环境变量
  if (process.env.USER_DATA_DIR) {
    const custom = path.resolve(process.env.USER_DATA_DIR);
    if (!fs.existsSync(custom)) {
      try { fs.mkdirSync(custom, { recursive: true }); } catch {}
    }
    return custom;
  }

  // 2. 自动检测多个可能存在已有数据的候选路径（优先选已有 .json 数据的目录）
  const candidates = [
    '/app/.cache/user_data',
    '/app/apps/web/.cache/user_data',
    path.resolve(process.cwd(), '.cache', 'user_data'),
    path.resolve(process.cwd(), '..', '..', '.cache', 'user_data'),
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const files = fs.readdirSync(c);
        if (files.some((f) => f.endsWith('.json'))) {
          return c;
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. 若无已有 json，取已存在的目录
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // 4. 回退
  const fallback = path.resolve(process.cwd(), '.cache', 'user_data');
  if (!fs.existsSync(fallback)) {
    try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  }
  return fallback;
}

function getUserFilePath(userId: string): string {
  const dataDir = getDataDir();
  // 对 userId 做安全文件名转义
  const safeFilename = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, `${safeFilename}.json`);
}

export function getUserData(userId: string): UserScopedData {
  const filePath = getUserFilePath(userId);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data.goals) data.goals = [];
      return data;
    }
  } catch (e) {
    console.error(`Failed to read user data for ${userId}:`, e);
  }

  // 默认空数据结构
  return {
    userId,
    connectors: {},
    activeModelId: 'deepseek',
    memories: [],
    cronJobs: [],
    missions: [],
    goals: [],
    updatedAt: Date.now(),
  };
}

export function saveUserData(data: UserScopedData) {
  const filePath = getUserFilePath(data.userId);
  try {
    data.updatedAt = Date.now();
    // 原子写入：先写临时文件再 rename，避免写入中途崩溃/并发读导致 JSON 损坏
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error(`Failed to save user data for ${data.userId}:`, e);
  }
}

// 辅助方法：连接器配置
export function getUserConnectors(userId: string) {
  const data = getUserData(userId);
  return {
    configs: data.connectors || {},
    activeModelId: data.activeModelId || 'deepseek',
  };
}

export function saveUserConnector(userId: string, envVar: string, value: string, extra?: { activeModelId?: string }) {
  const data = getUserData(userId);
  data.connectors = data.connectors || {};
  if (value) {
    data.connectors[envVar] = value;
  } else {
    delete data.connectors[envVar];
  }
  if (extra?.activeModelId) {
    data.activeModelId = extra.activeModelId;
  }
  saveUserData(data);
  return data;
}

export function setUserActiveModel(userId: string, modelId: string) {
  const data = getUserData(userId);
  data.activeModelId = modelId;
  saveUserData(data);
  return data;
}

// 辅助方法：记忆库
export function getUserMemories(userId: string): any[] {
  const data = getUserData(userId);
  return data.memories || [];
}

export function saveUserMemory(userId: string, memory: any) {
  const data = getUserData(userId);
  data.memories = data.memories || [];
  const existingIdx = data.memories.findIndex((m: any) => m.id === memory.id);
  if (existingIdx >= 0) {
    data.memories[existingIdx] = { ...data.memories[existingIdx], ...memory, updatedAt: Date.now() };
  } else {
    data.memories.push(memory);
  }
  saveUserData(data);
  return data.memories;
}

export function deleteUserMemory(userId: string, memoryId: string) {
  const data = getUserData(userId);
  data.memories = (data.memories || []).filter((m: any) => m.id !== memoryId);
  saveUserData(data);
  return data.memories;
}

// 辅助方法：巡航任务
export function getUserCronJobs(userId: string): any[] {
  const data = getUserData(userId);
  return data.cronJobs || [];
}

export function saveUserCronJob(userId: string, job: any) {
  const data = getUserData(userId);
  data.cronJobs = data.cronJobs || [];
  const existingIdx = data.cronJobs.findIndex((j: any) => j.id === job.id);
  if (existingIdx >= 0) {
    data.cronJobs[existingIdx] = { ...data.cronJobs[existingIdx], ...job };
  } else {
    data.cronJobs.push(job);
  }
  saveUserData(data);
  return data.cronJobs;
}

export function deleteUserCronJob(userId: string, jobId: string) {
  const data = getUserData(userId);
  data.cronJobs = (data.cronJobs || []).filter((j: any) => j.id !== jobId);
  saveUserData(data);
  return data.cronJobs;
}

// 辅助方法：任务流记录 (Missions)
export function getUserMissions(userId: string): any[] {
  const data = getUserData(userId);
  return data.missions || [];
}

export function saveUserMission(userId: string, mission: any) {
  const data = getUserData(userId);
  data.missions = data.missions || [];
  const existingIdx = data.missions.findIndex((m: any) => m.id === mission.id);
  if (existingIdx >= 0) {
    data.missions[existingIdx] = { ...data.missions[existingIdx], ...mission };
  } else {
    data.missions.unshift(mission);
    // 仅保留最近 50 条任务记录，避免单文件无限膨胀
    if (data.missions.length > 50) {
      data.missions = data.missions.slice(0, 50);
    }
  }
  saveUserData(data);
  return data.missions;
}

export function deleteUserMission(userId: string, missionId: string) {
  const data = getUserData(userId);
  data.missions = (data.missions || []).filter((m: any) => m.id !== missionId);
  saveUserData(data);
  return data.missions;
}

// 辅助方法：长期目标 (Long-term Goals & Milestones)
export function getUserGoals(userId: string): any[] {
  const data = getUserData(userId);
  return data.goals || [];
}

export function saveUserGoal(userId: string, goal: any) {
  const data = getUserData(userId);
  data.goals = data.goals || [];
  const existingIdx = data.goals.findIndex((g: any) => g.id === goal.id);
  if (existingIdx >= 0) {
    data.goals[existingIdx] = { ...data.goals[existingIdx], ...goal, updatedAt: Date.now() };
  } else {
    data.goals.unshift({ ...goal, createdAt: goal.createdAt || Date.now(), updatedAt: Date.now() });
  }
  saveUserData(data);
  return data.goals;
}

export function deleteUserGoal(userId: string, goalId: string) {
  const data = getUserData(userId);
  data.goals = (data.goals || []).filter((g: any) => g.id !== goalId);
  saveUserData(data);
  return data.goals;
}

// 辅助方法：读取所有用户数据（用于服务端启动时加载所有后台定时任务等）
export function getAllUsersData(): UserScopedData[] {
  const dataDir = getDataDir();
  try {
    if (!fs.existsSync(dataDir)) return [];
    const files = fs.readdirSync(dataDir);
    const result: UserScopedData[] = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(path.join(dataDir, f), 'utf-8');
          const data = JSON.parse(raw);
          if (data) {
            if (!data.userId) {
              data.userId = f.replace(/\.json$/, '');
            }
            result.push(data);
          }
        } catch {
          // ignore corrupted user files
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

