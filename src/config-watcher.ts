/**
 * 配置文件实时监控模块
 * 使用文件系统事件监听，无需轮询
 */

import { watch, existsSync, type FSWatcher } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  loadConfig,
  loadApiKey,
  type Config,
  type ApiKeyData,
} from "./storage";

// 配置文件路径
const CONFIG_DIR = join(homedir(), ".ccproxy");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const APIKEY_FILE = join(CONFIG_DIR, "apikey.json");

// 配置变更回调类型
type ConfigChangeCallback = (config: Config) => void;
type ApiKeyChangeCallback = (apiKey: ApiKeyData | null) => void;

// 监控器实例
let configWatcher: FSWatcher | null = null;
let apiKeyWatcher: FSWatcher | null = null;
let dirWatcher: FSWatcher | null = null;

// 当前配置缓存
let currentConfig: Config | null = null;
let currentApiKey: ApiKeyData | null = null;

// 回调函数列表
const configCallbacks: Set<ConfigChangeCallback> = new Set();
const apiKeyCallbacks: Set<ApiKeyChangeCallback> = new Set();

// 防抖定时器引用对象
const configDebounceRef = { current: null as ReturnType<typeof setTimeout> | null };
const apiKeyDebounceRef = { current: null as ReturnType<typeof setTimeout> | null };

// 防抖延迟（毫秒）
const DEBOUNCE_DELAY = 100;

/**
 * 防抖函数 - 避免文件变更事件触发过于频繁
 */
function debounce<T extends (...args: any[]) => void>(
  fn: T,
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  delay: number
): (...args: Parameters<T>) => void {
  return (...args: Parameters<T>) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      fn(...args);
      timerRef.current = null;
    }, delay);
  };
}

/**
 * 处理配置文件变更
 */
async function handleConfigChange(): Promise<void> {
  try {
    const newConfig = await loadConfig();
    
    // 检查配置是否真的发生了变化
    if (JSON.stringify(newConfig) !== JSON.stringify(currentConfig)) {
      currentConfig = newConfig;
      console.log(`[${new Date().toISOString()}] Config reloaded`);
      
      // 通知所有回调
      for (const callback of configCallbacks) {
        try {
          callback(newConfig);
        } catch (error) {
          console.error("Config change callback error:", error);
        }
      }
    }
  } catch (error) {
    console.error("Failed to reload config:", error);
  }
}

/**
 * 处理 API Key 文件变更
 */
async function handleApiKeyChange(): Promise<void> {
  try {
    const newApiKey = await loadApiKey();
    
    // 检查 API Key 是否真的发生了变化
    if (JSON.stringify(newApiKey) !== JSON.stringify(currentApiKey)) {
      currentApiKey = newApiKey;
      console.log(`[${new Date().toISOString()}] API Key config reloaded`);
      
      // 通知所有回调
      for (const callback of apiKeyCallbacks) {
        try {
          callback(newApiKey);
        } catch (error) {
          console.error("API Key change callback error:", error);
        }
      }
    }
  } catch (error) {
    console.error("Failed to reload API Key:", error);
  }
}

// 创建防抖处理器
const debouncedConfigChange = debounce(
  handleConfigChange,
  configDebounceRef,
  DEBOUNCE_DELAY
);

const debouncedApiKeyChange = debounce(
  handleApiKeyChange,
  apiKeyDebounceRef,
  DEBOUNCE_DELAY
);

/**
 * 启动配置文件监控
 */
export async function startConfigWatcher(): Promise<void> {
  // 先加载初始配置
  currentConfig = await loadConfig();
  currentApiKey = await loadApiKey();

  // 监控配置文件
  if (existsSync(CONFIG_FILE)) {
    try {
      configWatcher = watch(CONFIG_FILE, (eventType) => {
        if (eventType === "change") {
          debouncedConfigChange();
        }
      });
      
      configWatcher.on("error", (error) => {
        console.error("Config watcher error:", error);
      });
      
      console.log(`[${new Date().toISOString()}] Watching config file: ${CONFIG_FILE}`);
    } catch (error) {
      console.error("Failed to watch config file:", error);
    }
  }

  // 监控 API Key 文件
  if (existsSync(APIKEY_FILE)) {
    try {
      apiKeyWatcher = watch(APIKEY_FILE, (eventType) => {
        if (eventType === "change") {
          debouncedApiKeyChange();
        }
      });
      
      apiKeyWatcher.on("error", (error) => {
        console.error("API Key watcher error:", error);
      });
      
      console.log(`[${new Date().toISOString()}] Watching API Key file: ${APIKEY_FILE}`);
    } catch (error) {
      console.error("Failed to watch API Key file:", error);
    }
  }

  // 监控配置目录（用于检测新创建的文件）
  if (existsSync(CONFIG_DIR)) {
    try {
      dirWatcher = watch(CONFIG_DIR, (eventType, filename) => {
        if (filename === "config.json") {
          // 如果配置文件存在但没有监控器，尝试创建
          if (existsSync(CONFIG_FILE)) {
            if (!configWatcher) {
              configWatcher = watch(CONFIG_FILE, (eventType) => {
                if (eventType === "change") {
                  debouncedConfigChange();
                }
              });
              configWatcher.on("error", (error) => {
                console.error("Config watcher error:", error);
              });
              console.log(`[${new Date().toISOString()}] Started watching new config file`);
            }
          } else {
            // 文件被删除，关闭旧的 watcher
            if (configWatcher) {
              configWatcher.close();
              configWatcher = null;
              console.log(`[${new Date().toISOString()}] Config file deleted, watcher closed`);
            }
          }
          debouncedConfigChange();
        } else if (filename === "apikey.json") {
          // 如果 API Key 文件存在但没有监控器，尝试创建
          if (existsSync(APIKEY_FILE)) {
            if (!apiKeyWatcher) {
              apiKeyWatcher = watch(APIKEY_FILE, (eventType) => {
                if (eventType === "change") {
                  debouncedApiKeyChange();
                }
              });
              apiKeyWatcher.on("error", (error) => {
                console.error("API Key watcher error:", error);
              });
              console.log(`[${new Date().toISOString()}] Started watching new API Key file`);
            }
          } else {
            // 文件被删除，关闭旧的 watcher
            if (apiKeyWatcher) {
              apiKeyWatcher.close();
              apiKeyWatcher = null;
              console.log(`[${new Date().toISOString()}] API Key file deleted, watcher closed`);
            }
          }
          debouncedApiKeyChange();
        }
      });
      
      dirWatcher.on("error", (error) => {
        console.error("Config directory watcher error:", error);
      });
      
      console.log(`[${new Date().toISOString()}] Watching config directory: ${CONFIG_DIR}`);
    } catch (error) {
      console.error("Failed to watch config directory:", error);
    }
  }
}

/**
 * 停止配置文件监控
 */
export function stopConfigWatcher(): void {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  
  if (apiKeyWatcher) {
    apiKeyWatcher.close();
    apiKeyWatcher = null;
  }
  
  if (dirWatcher) {
    dirWatcher.close();
    dirWatcher = null;
  }
  
  // 清理防抖定时器
  if (configDebounceRef.current) {
    clearTimeout(configDebounceRef.current);
  }
  if (apiKeyDebounceRef.current) {
    clearTimeout(apiKeyDebounceRef.current);
  }
  
  console.log(`[${new Date().toISOString()}] Config watchers stopped`);
}

/**
 * 注册配置变更回调
 * @returns 取消注册的函数
 */
export function onConfigChange(callback: ConfigChangeCallback): () => void {
  configCallbacks.add(callback);
  
  // 立即用当前配置调用一次
  if (currentConfig) {
    callback(currentConfig);
  }
  
  return () => {
    configCallbacks.delete(callback);
  };
}

/**
 * 注册 API Key 变更回调
 * @returns 取消注册的函数
 */
export function onApiKeyChange(callback: ApiKeyChangeCallback): () => void {
  apiKeyCallbacks.add(callback);
  
  // 立即用当前 API Key 调用一次
  callback(currentApiKey);
  
  return () => {
    apiKeyCallbacks.delete(callback);
  };
}

/**
 * 获取当前配置（同步方法，使用缓存）
 */
export function getCurrentConfig(): Config | null {
  return currentConfig;
}

/**
 * 获取当前 API Key 配置（同步方法，使用缓存）
 */
export function getCurrentApiKey(): ApiKeyData | null {
  return currentApiKey;
}

/**
 * 强制重新加载配置
 */
export async function reloadConfig(): Promise<Config> {
  currentConfig = await loadConfig();
  return currentConfig;
}

/**
 * 强制重新加载 API Key
 */
export async function reloadApiKey(): Promise<ApiKeyData | null> {
  currentApiKey = await loadApiKey();
  return currentApiKey;
}
