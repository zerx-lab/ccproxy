import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";

const CONFIG_DIR = join(homedir(), ".ccproxy");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const APIKEY_FILE = join(CONFIG_DIR, "apikey.json");

export interface AuthData {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

export interface ApiKeyData {
  /** API Key (sk-xxx 格式) */
  key: string;
  /** 创建时间 */
  createdAt: number;
}

export interface Config {
  /** 模型名称映射 */
  modelMapping: Record<string, string>;
  /** 服务器配置 */
  server: {
    port: number;
    host: string;
  };
}

const DEFAULT_CONFIG: Config = {
  modelMapping: {
    // OpenAI 模型映射
    "gpt-5.2-codex": "claude-opus-4-5",
    "gpt-5.2": "claude-sonnet-4-5",
    "gpt-5.1-codex-max": "claude-haiku-4-5",
    "gpt-5.1-codex-mini": "claude-haiku-4-5",
  },
  server: {
    port: 3456,
    host: "127.0.0.1",
  },
};

export async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

export async function saveAuth(auth: AuthData): Promise<void> {
  await ensureConfigDir();
  await writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
}

export async function loadAuth(): Promise<AuthData | null> {
  try {
    if (!existsSync(AUTH_FILE)) {
      return null;
    }
    const content = await readFile(AUTH_FILE, "utf-8");
    return JSON.parse(content) as AuthData;
  } catch {
    return null;
  }
}

export async function clearAuth(): Promise<void> {
  try {
    if (existsSync(AUTH_FILE)) {
      await unlink(AUTH_FILE);
    }
  } catch {
    // ignore
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigFile(): string {
  return CONFIG_FILE;
}

export async function loadConfig(): Promise<Config> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      // 如果配置文件不存在，创建默认配置
      await saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    const content = await readFile(CONFIG_FILE, "utf-8");
    const userConfig = JSON.parse(content) as Partial<Config>;
    // 合并默认配置和用户配置
    return {
      modelMapping: {
        ...DEFAULT_CONFIG.modelMapping,
        ...userConfig.modelMapping,
      },
      server: { ...DEFAULT_CONFIG.server, ...userConfig.server },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function getDefaultConfig(): Config {
  return DEFAULT_CONFIG;
}

/**
 * 生成随机的 API Key
 * 格式: sk-ccproxy-xxxxxxxxxxxxxxxxxxxx (32位随机字符)
 */
export function generateApiKey(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let randomPart = "";
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  for (let i = 0; i < 32; i++) {
    randomPart += chars[array[i]! % chars.length];
  }
  return `sk-ccproxy-${randomPart}`;
}

/**
 * 保存 API Key
 */
export async function saveApiKey(apiKey: ApiKeyData): Promise<void> {
  await ensureConfigDir();
  await writeFile(APIKEY_FILE, JSON.stringify(apiKey, null, 2), "utf-8");
}

/**
 * 加载 API Key
 */
export async function loadApiKey(): Promise<ApiKeyData | null> {
  try {
    if (!existsSync(APIKEY_FILE)) {
      return null;
    }
    const content = await readFile(APIKEY_FILE, "utf-8");
    return JSON.parse(content) as ApiKeyData;
  } catch {
    return null;
  }
}

/**
 * 清除 API Key
 */
export async function clearApiKey(): Promise<void> {
  try {
    if (existsSync(APIKEY_FILE)) {
      await unlink(APIKEY_FILE);
    }
  } catch {
    // ignore
  }
}

/**
 * 验证 API Key 是否有效
 */
export async function validateApiKey(key: string): Promise<boolean> {
  const stored = await loadApiKey();
  if (!stored) {
    return false;
  }
  return stored.key === key;
}
