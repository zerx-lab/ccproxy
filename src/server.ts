/**
 * CCProxy 代理服务器
 * 主服务器模块 - 负责组装和启动服务器
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadAuth, loadConfig, type Config } from "./storage";
import { ensureLogDir, getLogDir } from "./logger";
import { createApiKeyMiddleware } from "./middleware/api-key";
import { createChatCompletionsHandler } from "./handlers/chat-completions";
import { createMessagesHandler } from "./handlers/messages";
import { createResponsesHandler } from "./handlers/responses";
import { handleModels } from "./handlers/models";
import {
  startConfigWatcher,
  stopConfigWatcher,
  onConfigChange,
  onApiKeyChange,
} from "./config-watcher";
import type { ProxyOptions } from "./types";

// 当前配置引用（用于动态更新）
let modelMapping: Record<string, string> = {};
let apiKeyRequired = false;

/**
 * 模型名称映射函数（使用最新配置）
 */
function mapModelName(model: string): string {
  return modelMapping[model] || model;
}

/**
 * 创建并启动代理服务器
 */
export async function startServer(options: ProxyOptions) {
  const { port, host } = options;

  // 检查认证状态
  const auth = await loadAuth();
  if (!auth) {
    console.error(
      "Error: Not authenticated. Please run 'ccproxy login' first."
    );
    process.exit(1);
  }

  // 启动配置文件监控
  await startConfigWatcher();

  // 注册配置变更回调
  onConfigChange((config: Config) => {
    modelMapping = config.modelMapping;
    console.log(`[${new Date().toISOString()}] Model mapping updated:`, Object.keys(modelMapping).length, "mappings");
  });

  // 注册 API Key 变更回调
  onApiKeyChange((apiKey) => {
    apiKeyRequired = apiKey !== null;
    console.log(`[${new Date().toISOString()}] API Key authentication: ${apiKeyRequired ? "ENABLED" : "DISABLED"}`);
  });

  const app = new Hono();

  // 健康检查（不需要认证）
  app.get("/health", (c) => c.json({ status: "ok" }));

  // API Key 验证中间件（动态检查）
  app.use("/v1/*", async (c, next) => {
    // 动态获取当前 API Key 状态
    const middleware = createApiKeyMiddleware(apiKeyRequired);
    return middleware(c, next);
  });

  // 注册路由（使用动态 mapModelName）
  // OpenAI Chat Completions API
  app.post("/v1/chat/completions", createChatCompletionsHandler(mapModelName));

  // Anthropic Messages API
  app.post("/v1/messages", createMessagesHandler(mapModelName));

  // OpenAI Responses API
  app.post("/v1/responses", createResponsesHandler(mapModelName));

  // Models API
  app.get("/v1/models", handleModels);

  // 确保日志目录存在
  ensureLogDir();

  // 打印启动信息
  console.log(`CCProxy server starting on http://${host}:${port}`);
  console.log("Available endpoints:");
  console.log(`  - POST /v1/chat/completions (OpenAI Chat Completions API)`);
  console.log(`  - POST /v1/responses (OpenAI Responses API)`);
  console.log(`  - POST /v1/messages (Anthropic native)`);
  console.log(`  - GET  /v1/models`);
  console.log(`  - GET  /health`);
  console.log(`Logs directory: ${getLogDir()}`);
  console.log(`Hot reload: ENABLED (config files are watched)`);

  // 处理进程退出
  const cleanup = () => {
    console.log("\nShutting down...");
    stopConfigWatcher();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });
}
