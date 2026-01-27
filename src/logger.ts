/**
 * CCProxy 日志模块
 * 负责请求/响应/错误日志的记录
 */

import * as fs from "fs";
import * as path from "path";
import type { LogEntry } from "./types";

/** 日志目录 */
const LOG_DIR = path.join(process.cwd(), "logs");

/**
 * 确保日志目录存在
 */
export function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * 获取当前日志文件路径（按日期分割）
 */
export function getLogFilePath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(LOG_DIR, `ccproxy-${date}.log`);
}

/**
 * 获取日志目录路径
 */
export function getLogDir(): string {
  return LOG_DIR;
}

/**
 * 写入日志
 */
export function writeLog(entry: LogEntry): void {
  ensureLogDir();
  const logLine = JSON.stringify(entry) + "\n";
  fs.appendFileSync(getLogFilePath(), logLine, "utf-8");
}

/**
 * 记录请求
 */
export function logRequest(
  endpoint: string,
  method: string,
  body: any,
  headers?: Record<string, string>
): void {
  writeLog({
    timestamp: new Date().toISOString(),
    type: "request",
    endpoint,
    method,
    data: {
      body,
      headers,
    },
  });
  console.log(`[${new Date().toISOString()}] ${method} ${endpoint}`);
}

/**
 * 记录响应
 */
export function logResponse(
  endpoint: string,
  method: string,
  status: number,
  body?: any
): void {
  writeLog({
    timestamp: new Date().toISOString(),
    type: "response",
    endpoint,
    method,
    data: {
      status,
      body: body
        ? typeof body === "string"
          ? body.substring(0, 1000)
          : body
        : undefined,
    },
  });
}

/**
 * 记录错误
 */
export function logError(endpoint: string, method: string, error: any): void {
  writeLog({
    timestamp: new Date().toISOString(),
    type: "error",
    endpoint,
    method,
    data: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
  console.error(
    `[${new Date().toISOString()}] ERROR ${method} ${endpoint}:`,
    error
  );
}
