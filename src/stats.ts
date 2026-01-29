/**
 * CCProxy Token 使用量统计模块
 * 异步非阻塞方式记录 token 使用量，按 API Key、日期、小时聚合
 */

import { join } from "path";
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { getConfigDir } from "./storage";

// 统计数据目录
const STATS_DIR = join(getConfigDir(), "stats");

/** 单次请求的使用量记录 */
export interface UsageRecord {
  apiKey: string;      // API Key (脱敏后的前缀)
  model: string;       // 使用的模型
  endpoint: string;    // API 端点
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;   // Unix 时间戳
}

/** 按小时聚合的统计数据 */
export interface HourlyStats {
  hour: string;        // 格式: "HH"
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

/** 按日期聚合的统计数据 */
export interface DailyStats {
  date: string;        // 格式: "YYYY-MM-DD"
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  hourly: Record<string, HourlyStats>;
  models: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
  }>;
}

/** 按 API Key 聚合的统计数据 */
export interface KeyStats {
  apiKey: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  daily: Record<string, DailyStats>;
}

/** 内存缓存 */
const statsCache: Map<string, KeyStats> = new Map();

/** 写入队列 - 用于异步批量写入 */
const writeQueue: UsageRecord[] = [];
let writeTimer: Timer | null = null;
const WRITE_INTERVAL = 5000; // 5秒批量写入一次

/**
 * 确保统计目录存在
 */
async function ensureStatsDir(): Promise<void> {
  if (!existsSync(STATS_DIR)) {
    await mkdir(STATS_DIR, { recursive: true });
  }
}

/**
 * 获取 API Key 的脱敏标识
 */
export function maskApiKey(apiKey: string | null | undefined): string {
  if (!apiKey) return "anonymous";
  if (apiKey.startsWith("sk-ccproxy-")) {
    return apiKey.substring(0, 16);
  }
  return apiKey.substring(0, 8);
}

/**
 * 获取统计文件路径
 */
function getStatsFilePath(maskedKey: string): string {
  return join(STATS_DIR, `${maskedKey}.json`);
}

/**
 * 加载某个 API Key 的统计数据
 */
async function loadKeyStats(maskedKey: string): Promise<KeyStats> {
  if (statsCache.has(maskedKey)) {
    return statsCache.get(maskedKey)!;
  }

  await ensureStatsDir();
  const filePath = getStatsFilePath(maskedKey);

  let stats: KeyStats;
  try {
    if (existsSync(filePath)) {
      const content = await readFile(filePath, "utf-8");
      stats = JSON.parse(content) as KeyStats;
    } else {
      stats = {
        apiKey: maskedKey,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalRequests: 0,
        daily: {},
      };
    }
  } catch {
    stats = {
      apiKey: maskedKey,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
      daily: {},
    };
  }

  statsCache.set(maskedKey, stats);
  return stats;
}

/**
 * 保存某个 API Key 的统计数据
 */
async function saveKeyStats(maskedKey: string, stats: KeyStats): Promise<void> {
  await ensureStatsDir();
  const filePath = getStatsFilePath(maskedKey);
  await writeFile(filePath, JSON.stringify(stats, null, 2), "utf-8");
}

/**
 * 处理单条使用记录
 */
async function processRecord(record: UsageRecord): Promise<void> {
  const maskedKey = record.apiKey;
  const stats = await loadKeyStats(maskedKey);

  const date = new Date(record.timestamp);
  const dateStr = date.toISOString().split("T")[0]!;
  const hourStr = date.getHours().toString().padStart(2, "0");

  stats.totalInputTokens += record.inputTokens;
  stats.totalOutputTokens += record.outputTokens;
  stats.totalTokens += record.totalTokens;
  stats.totalRequests += 1;

  if (!stats.daily[dateStr]) {
    stats.daily[dateStr] = {
      date: dateStr,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      hourly: {},
      models: {},
    };
  }
  const daily = stats.daily[dateStr]!;

  daily.inputTokens += record.inputTokens;
  daily.outputTokens += record.outputTokens;
  daily.totalTokens += record.totalTokens;
  daily.requestCount += 1;

  if (!daily.hourly[hourStr]) {
    daily.hourly[hourStr] = {
      hour: hourStr,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };
  }
  const hourly = daily.hourly[hourStr]!;

  hourly.inputTokens += record.inputTokens;
  hourly.outputTokens += record.outputTokens;
  hourly.totalTokens += record.totalTokens;
  hourly.requestCount += 1;

  if (!daily.models[record.model]) {
    daily.models[record.model] = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };
  }
  const model = daily.models[record.model]!;

  model.inputTokens += record.inputTokens;
  model.outputTokens += record.outputTokens;
  model.totalTokens += record.totalTokens;
  model.requestCount += 1;

  statsCache.set(maskedKey, stats);
}

/**
 * 批量处理写入队列
 */
async function flushWriteQueue(): Promise<void> {
  if (writeQueue.length === 0) return;

  const records = writeQueue.splice(0, writeQueue.length);
  const keyRecords = new Map<string, UsageRecord[]>();
  
  for (const record of records) {
    const key = record.apiKey;
    if (!keyRecords.has(key)) {
      keyRecords.set(key, []);
    }
    keyRecords.get(key)!.push(record);
  }

  await Promise.all(
    Array.from(keyRecords.entries()).map(async ([maskedKey, recs]) => {
      for (const record of recs) {
        await processRecord(record);
      }
      const stats = statsCache.get(maskedKey);
      if (stats) {
        await saveKeyStats(maskedKey, stats);
      }
    })
  );
}

/**
 * 记录 token 使用量（异步非阻塞）
 */
export function recordUsage(record: UsageRecord): void {
  writeQueue.push(record);

  if (!writeTimer) {
    writeTimer = setTimeout(async () => {
      writeTimer = null;
      try {
        await flushWriteQueue();
      } catch (error) {
        console.error("[stats] Failed to flush write queue:", error);
      }
    }, WRITE_INTERVAL);
  }
}

/**
 * 获取所有 API Key 的统计数据
 */
export async function getAllStats(): Promise<KeyStats[]> {
  await ensureStatsDir();

  try {
    const files = await readdir(STATS_DIR);
    const jsonFiles = files.filter(f => f.endsWith(".json"));

    const results: KeyStats[] = [];
    for (const file of jsonFiles) {
      const maskedKey = file.replace(".json", "");
      const stats = await loadKeyStats(maskedKey);
      results.push(stats);
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * 获取指定 API Key 的统计数据
 */
export async function getKeyStatsData(maskedKey: string): Promise<KeyStats | null> {
  try {
    return await loadKeyStats(maskedKey);
  } catch {
    return null;
  }
}

/**
 * 强制刷新写入队列（用于优雅关闭）
 */
export async function flushStats(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await flushWriteQueue();
}
