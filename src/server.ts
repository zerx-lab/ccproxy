import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamText, jsonSchema, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getValidAccessToken } from "./auth";
import {
  loadAuth,
  saveAuth,
  loadConfig,
  loadApiKey,
  validateApiKey,
  type AuthData,
  type Config,
} from "./storage";
import * as fs from "fs";
import * as path from "path";

const TOOL_PREFIX = "mcp_";
const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// 日志目录
const LOG_DIR = path.join(process.cwd(), "logs");

// 确保日志目录存在
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// 获取当前日志文件路径（按日期分割）
function getLogFilePath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(LOG_DIR, `ccproxy-${date}.log`);
}

// 写入日志
function writeLog(entry: {
  timestamp: string;
  type: "request" | "response" | "error";
  endpoint: string;
  method: string;
  data: any;
}) {
  ensureLogDir();
  const logLine = JSON.stringify(entry) + "\n";
  fs.appendFileSync(getLogFilePath(), logLine, "utf-8");
}

// 记录请求
function logRequest(
  endpoint: string,
  method: string,
  body: any,
  headers?: Record<string, string>,
) {
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

// 记录响应
function logResponse(
  endpoint: string,
  method: string,
  status: number,
  body?: any,
) {
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

// 记录错误
function logError(endpoint: string, method: string, error: any) {
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
    error,
  );
}

// Claude Code API 请求的通用配置
const CLAUDE_CODE_HEADERS = {
  "anthropic-beta":
    "oauth-2025-04-20,interleaved-thinking-2025-05-14,claude-code-20250219",
  "user-agent": "claude-cli/2.1.2 (external, cli)",
  "anthropic-version": "2023-06-01",
};

// 默认的 placeholder tool，用于确保请求被识别为 Claude Code 请求
const DEFAULT_CLAUDE_CODE_TOOL = {
  name: "mcp_placeholder",
  description: "Placeholder tool for Claude Code compatibility",
  input_schema: {
    type: "object",
    properties: {},
  },
};

/**
 * 统一处理 Claude Code 代理请求体
 * - 添加 Claude Code system prompt（数组格式）
 * - 处理 tools 名称前缀和 input_schema
 * - 处理消息中的 tool_use blocks
 * - 确保至少有一个带 mcp_ 前缀的 tool
 */
function processClaudeCodeRequestBody(body: any): any {
  const parsed = typeof body === "string" ? JSON.parse(body) : { ...body };

  // 1. 添加 Claude Code system prompt（始终使用数组格式以匹配 Claude Code 实际格式）
  if (!parsed.system) {
    parsed.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }];
  } else if (typeof parsed.system === "string") {
    parsed.system = [
      { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: "text", text: parsed.system },
    ];
  } else if (Array.isArray(parsed.system)) {
    parsed.system = [
      { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
      ...parsed.system,
    ];
  }

  // 2. 处理 tools - 添加名称前缀并确保 input_schema 格式正确
  if (parsed.tools && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    parsed.tools = parsed.tools.map((tool: any) => {
      // 处理 custom 类型的 tool（新格式）
      if (tool.type === "custom" && tool.custom) {
        return {
          ...tool,
          custom: {
            ...tool.custom,
            name: tool.custom.name
              ? `${TOOL_PREFIX}${tool.custom.name}`
              : tool.custom.name,
            input_schema: tool.custom.input_schema
              ? { type: "object", ...tool.custom.input_schema }
              : { type: "object", properties: {} },
          },
        };
      }
      // 处理传统格式的 tool
      const result = {
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      };
      // 确保 input_schema 有 type 字段
      if (result.input_schema) {
        result.input_schema = { type: "object", ...result.input_schema };
      }
      return result;
    });
  } else {
    // 如果没有 tools，添加一个默认的 placeholder tool 以确保请求被识别为 Claude Code 请求
    parsed.tools = [DEFAULT_CLAUDE_CODE_TOOL];
  }

  // 3. 处理消息中的 tool_use blocks
  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map((msg: any) => {
      if (msg.content && Array.isArray(msg.content)) {
        msg.content = msg.content.map((block: any) => {
          if (block.type === "tool_use" && block.name) {
            return {
              ...block,
              name: `${TOOL_PREFIX}${block.name}`,
            };
          }
          return block;
        });
      }
      return msg;
    });
  }

  return parsed;
}

/**
 * 从响应文本中移除 tool 名称前缀
 */
function removeToolPrefixFromResponse(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
}

/**
 * 将 OpenAI Chat Completions 格式的 tools 转换为 AI SDK 格式
 * OpenAI: [{ type: "function", function: { name, description, parameters } }]
 * AI SDK: { toolName: tool({ description, inputSchema: jsonSchema({...}) }) }
 */
function convertOpenAIToolsToAISDK(openaiTools: any[]): Record<string, any> {
  const aiSdkTools: Record<string, any> = {};

  for (const t of openaiTools) {
    // OpenAI 格式: { type: "function", function: { name, description, parameters } }
    const func = t.function || t;
    const name = func.name || t.name;
    const description = func.description || t.description || "";
    const parameters = func.parameters ||
      t.parameters || { type: "object", properties: {} };

    if (name) {
      aiSdkTools[name] = tool({
        description,
        inputSchema: jsonSchema(parameters),
      });
    }
  }

  return aiSdkTools;
}

/**
 * 将 OpenAI Responses API 的 input 转换为 AI SDK messages 格式
 * @returns { messages, systemPrompt }
 */
function convertResponsesInputToAISDK(
  input: string | ResponseInputItem[] | undefined,
  instructions?: string,
): {
  messages: any[];
  system?: string;
} {
  let system = instructions;
  const messages: any[] = [];

  if (typeof input === "string") {
    // 简单字符串输入
    if (input.trim()) {
      messages.push({ role: "user", content: input });
    }
  } else if (Array.isArray(input)) {
    for (const item of input as any[]) {
      // 处理 message 类型
      if (item.type === "message") {
        // 提取文本内容
        let textContent = "";
        if (typeof item.content === "string") {
          textContent = item.content;
        } else if (Array.isArray(item.content)) {
          textContent = item.content
            .map((p: any) => p.text || p.input_text || "")
            .filter(Boolean)
            .join("");
        }

        // 处理 developer/system 角色 -> 合并到 system prompt
        if (item.role === "developer" || item.role === "system") {
          if (textContent.trim()) {
            system = system ? `${system}\n\n${textContent}` : textContent;
          }
        } else {
          // user/assistant 消息
          let content: any;
          if (typeof item.content === "string") {
            content = item.content;
          } else if (Array.isArray(item.content)) {
            // 转换 content parts，过滤空内容
            const parts: Array<{
              type: string;
              text?: string;
              image?: string;
            }> = [];
            for (const part of item.content as any[]) {
              if (part.type === "input_text" && part.text) {
                parts.push({ type: "text", text: part.text });
              } else if (part.type === "input_image" && part.image_url) {
                parts.push({ type: "image", image: part.image_url });
              } else if (part.type === "text" && part.text) {
                parts.push({ type: "text", text: part.text });
              } else if (part.type === "output_text" && part.text) {
                // 处理 output_text（可能来自历史响应）
                parts.push({ type: "text", text: part.text });
              }
            }

            // 如果只有一个文本部分，简化为字符串
            if (
              parts.length === 1 &&
              parts[0]?.type === "text" &&
              parts[0]?.text
            ) {
              content = parts[0].text;
            } else if (parts.length > 0) {
              content = parts;
            }
          }

          // 只添加有内容的消息
          if (
            content &&
            (typeof content === "string" ? content.trim() : content.length > 0)
          ) {
            messages.push({ role: item.role, content });
          }
        }
      }
      // 处理 function_call_output 类型（工具调用结果）
      else if (item.type === "function_call_output") {
        // 这是工具调用的结果，需要作为 tool_result 处理
        // AI SDK 会自动处理，这里跳过
        console.log(
          `[convertResponsesInputToAISDK] Skipping function_call_output: ${item.call_id}`,
        );
      }
      // 其他未知类型，记录日志
      else {
        console.log(
          `[convertResponsesInputToAISDK] Unknown item type: ${item.type}`,
        );
      }
    }
  }

  // 确保至少有一条消息
  if (messages.length === 0 && !input) {
    // 如果没有输入，添加一个默认的用户消息
    messages.push({ role: "user", content: "Hello" });
  }

  return { messages, system };
}

/**
 * 发送 Claude Code API 请求
 */
async function sendClaudeCodeRequest(
  accessToken: string,
  body: any,
  stream: boolean = false,
): Promise<Response> {
  const url = new URL("https://api.anthropic.com/v1/messages");
  url.searchParams.set("beta", "true");

  const processedBody = processClaudeCodeRequestBody(body);
  const bodyStr = JSON.stringify(processedBody);

  // 记录发送给 Anthropic API 的实际请求
  writeLog({
    timestamp: new Date().toISOString(),
    type: "request",
    endpoint: "anthropic:/v1/messages",
    method: "POST",
    data: {
      url: url.toString(),
      bodySize: bodyStr.length,
      headers: CLAUDE_CODE_HEADERS,
    },
  });

  console.log(
    `[${new Date().toISOString()}] Sending request to Anthropic API (body size: ${bodyStr.length} bytes)`,
  );

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes timeout

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${accessToken}`,
        ...CLAUDE_CODE_HEADERS,
      },
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 记录 Anthropic API 的响应状态
    writeLog({
      timestamp: new Date().toISOString(),
      type: "response",
      endpoint: "anthropic:/v1/messages",
      method: "POST",
      data: {
        status: response.status,
        statusText: response.statusText,
      },
    });

    console.log(
      `[${new Date().toISOString()}] Anthropic API response: ${response.status} ${response.statusText}`,
    );

    return response;
  } catch (error) {
    // 记录错误详情
    writeLog({
      timestamp: new Date().toISOString(),
      type: "error",
      endpoint: "anthropic:/v1/messages",
      method: "POST",
      data: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Unknown",
        code: (error as any).code,
      },
    });

    console.error(`[${new Date().toISOString()}] Anthropic API error:`, error);
    throw error;
  }
}

// OpenAI Responses API 类型定义
interface ResponsesAPIRequest {
  model: string;
  input?: string | ResponseInputItem[];
  instructions?: string;
  tools?: ResponseTool[];
  tool_choice?: "none" | "auto" | "required";
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  metadata?: Record<string, string>;
  previous_response_id?: string;
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high";
    summary?: "auto" | "concise" | "detailed";
  };
  truncation?: "auto" | "disabled";
  parallel_tool_calls?: boolean;
}

interface ResponseInputItem {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponseContentPart[];
}

interface ResponseContentPart {
  type: "input_text" | "input_image" | "input_file";
  text?: string;
  image_url?: string;
  file_id?: string;
}

interface ResponseTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, any>;
  strict?: boolean;
}

interface ResponseOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  content: ResponseOutputContent[];
  status: "in_progress" | "completed" | "incomplete";
}

interface ResponseOutputContent {
  type: "output_text";
  text: string;
  annotations?: any[];
}

interface ResponsesAPIResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress" | "cancelled" | "incomplete";
  model: string;
  output: ResponseOutputMessage[];
  output_text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  };
  error?: { code: string; message: string } | null;
  incomplete_details?: { reason: string } | null;
  instructions?: string | null;
  metadata?: Record<string, string>;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: ResponseTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  truncation?: string;
  previous_response_id?: string | null;
  reasoning?: any;
}
interface ProxyOptions {
  port: number;
  host: string;
}

/**
 * 创建自定义的 Anthropic fetch 函数，用于处理 OAuth 认证
 * @param getAccessToken - 获取访问令牌的函数
 */
function createAuthenticatedFetch(
  getAccessToken: () => Promise<string | null>,
) {
  return async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      throw new Error("Not authenticated. Please run 'ccproxy login' first.");
    }

    const requestInit = init ?? {};
    const requestHeaders = new Headers(requestInit.headers);

    // 设置认证 headers
    requestHeaders.set("authorization", `Bearer ${accessToken}`);
    Object.entries(CLAUDE_CODE_HEADERS).forEach(([key, value]) => {
      requestHeaders.set(key, value);
    });
    requestHeaders.delete("x-api-key");

    // 使用统一函数处理请求体
    let body = requestInit.body;
    if (body && typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        const processed = processClaudeCodeRequestBody(parsed);
        body = JSON.stringify(processed);
      } catch {
        // ignore parse errors
      }
    }

    // 修改 URL 添加 beta 参数
    let requestInput: string | URL | globalThis.Request = input;
    try {
      let requestUrl: URL | null = null;
      if (typeof input === "string" || input instanceof URL) {
        requestUrl = new URL(input.toString());
      } else if (input instanceof Request) {
        requestUrl = new URL(input.url);
      }

      if (
        requestUrl &&
        requestUrl.pathname === "/v1/messages" &&
        !requestUrl.searchParams.has("beta")
      ) {
        requestUrl.searchParams.set("beta", "true");
        requestInput =
          input instanceof Request
            ? new Request(requestUrl.toString(), input)
            : requestUrl;
      }
    } catch {
      // ignore URL errors
    }

    const response = await fetch(requestInput, {
      ...requestInit,
      body,
      headers: requestHeaders,
    });

    // 转换响应中的工具名称（移除 mcp_ 前缀）
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }

          let text = decoder.decode(value, { stream: true });
          text = removeToolPrefixFromResponse(text);
          controller.enqueue(encoder.encode(text));
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
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
      "Error: Not authenticated. Please run 'ccproxy login' first.",
    );
    process.exit(1);
  }

  // 加载配置
  const config = await loadConfig();
  const mapModelName = (model: string): string => {
    return config.modelMapping[model] || model;
  };

  const app = new Hono();

  // 加载 API Key 配置
  const apiKeyData = await loadApiKey();
  const requireApiKey = apiKeyData !== null;

  // 健康检查（不需要认证）
  app.get("/health", (c) => c.json({ status: "ok" }));

  // API Key 验证中间件
  app.use("/v1/*", async (c, next) => {
    // 如果没有配置 API Key，跳过验证
    if (!requireApiKey) {
      return next();
    }

    // 从请求头获取 API Key
    const authHeader = c.req.header("authorization");
    const xApiKey = c.req.header("x-api-key");

    let providedKey: string | null = null;

    if (authHeader) {
      // 支持 "Bearer sk-xxx" 格式
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) {
        providedKey = match[1] ?? null;
      }
    }

    if (!providedKey && xApiKey) {
      providedKey = xApiKey;
    }

    if (!providedKey) {
      return c.json(
        {
          error: {
            message:
              "Missing API key. Provide it via 'Authorization: Bearer sk-xxx' or 'x-api-key' header.",
            type: "authentication_error",
            code: "missing_api_key",
          },
        },
        401,
      );
    }

    const isValid = await validateApiKey(providedKey);
    if (!isValid) {
      return c.json(
        {
          error: {
            message: "Invalid API key.",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    return next();
  });

  // 兼容 OpenAI 格式的 /v1/chat/completions 端点
  app.post("/v1/chat/completions", async (c) => {
    const endpoint = "/v1/chat/completions";
    try {
      const body = await c.req.json();
      logRequest(endpoint, "POST", body);
      const {
        model,
        messages,
        tools: openaiTools,
        stream = false,
        ...rest
      } = body;

      // 将 OpenAI 格式的 tools 转换为 AI SDK 格式
      const aiSdkTools =
        openaiTools && Array.isArray(openaiTools) && openaiTools.length > 0
          ? convertOpenAIToolsToAISDK(openaiTools)
          : undefined;

      // 创建带认证的 Anthropic 客户端
      const anthropic = createAnthropic({
        apiKey: "", // 使用自定义 fetch，不需要 API key
        fetch: createAuthenticatedFetch(getValidAccessToken) as typeof fetch,
      });

      // 映射模型名称
      const modelId = mapModelName(model);

      if (stream) {
        // 流式响应 - OpenAI 兼容格式
        const result = streamText({
          model: anthropic(modelId),
          messages: messages,
          tools: aiSdkTools,
          ...rest,
        });

        const encoder = new TextEncoder();
        const chatId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        const sseStream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of result.textStream) {
                const data = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created,
                  model: modelId,
                  choices: [
                    {
                      index: 0,
                      delta: { content: chunk },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
                );
              }

              // 发送结束标记
              const doneData = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(doneData)}\n\n`),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch (error) {
              console.error("Stream error:", error);
              controller.error(error);
            }
          },
        });

        return new Response(sseStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        // 非流式响应
        const result = streamText({
          model: anthropic(modelId),
          messages: messages,
          tools: aiSdkTools,
          ...rest,
        });

        const text = await result.text;
        const usage = await result.usage;

        return c.json({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: text,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: (usage as any).promptTokens || 0,
            completion_tokens: (usage as any).completionTokens || 0,
            total_tokens: (usage as any).totalTokens || 0,
          },
        });
      }
    } catch (error) {
      logError(endpoint, "POST", error);
      return c.json(
        {
          error: {
            message: error instanceof Error ? error.message : "Unknown error",
            type: "api_error",
          },
        },
        500,
      );
    }
  });

  // 原生 Anthropic API 代理 /v1/messages
  app.post("/v1/messages", async (c) => {
    const endpoint = "/v1/messages";
    try {
      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        logError(endpoint, "POST", "Not authenticated");
        return c.json({ error: { message: "Not authenticated" } }, 401);
      }

      const body = await c.req.text();
      logRequest(endpoint, "POST", JSON.parse(body));

      // 使用统一函数处理请求体
      let isStreaming = false;
      let processedBody: any;
      try {
        const parsed = JSON.parse(body);
        isStreaming = parsed.stream === true;
        processedBody = processClaudeCodeRequestBody(parsed);
      } catch {
        processedBody = body;
      }

      const response = await sendClaudeCodeRequest(
        accessToken,
        processedBody,
        isStreaming,
      );

      // 如果是流式响应，转换工具名称
      if (response.body && isStreaming) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }

            let text = decoder.decode(value, { stream: true });
            text = removeToolPrefixFromResponse(text);
            controller.enqueue(encoder.encode(text));
          },
        });

        return new Response(stream, {
          status: response.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // 非流式响应
      let responseText = await response.text();
      responseText = removeToolPrefixFromResponse(responseText);

      return new Response(responseText, {
        status: response.status,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      logError(endpoint, "POST", error);
      return c.json(
        {
          error: {
            message: error instanceof Error ? error.message : "Unknown error",
          },
        },
        500,
      );
    }
  });

  // OpenAI Responses API 兼容端点
  app.post("/v1/responses", async (c) => {
    const endpoint = "/v1/responses";
    try {
      const body = (await c.req.json()) as ResponsesAPIRequest;
      logRequest(endpoint, "POST", body);
      const {
        model,
        input,
        instructions,
        tools: openaiTools,
        stream = false,
        ...rest
      } = body;

      // 映射模型名称
      const modelId = mapModelName(model);

      // 转换 input 为 AI SDK messages 格式
      const { messages, system } = convertResponsesInputToAISDK(
        input,
        instructions,
      );

      // 转换 tools 为 AI SDK 格式
      const aiSdkTools =
        openaiTools && Array.isArray(openaiTools) && openaiTools.length > 0
          ? convertOpenAIToolsToAISDK(openaiTools)
          : undefined;

      // 创建带认证的 Anthropic 客户端
      const anthropic = createAnthropic({
        apiKey: "",
        fetch: createAuthenticatedFetch(getValidAccessToken) as typeof fetch,
      });

      // 生成响应 ID
      const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        // 流式响应
        const result = streamText({
          model: anthropic(modelId),
          messages,
          system,
          tools: aiSdkTools,
          temperature: rest.temperature,
          topP: rest.top_p,
          maxOutputTokens: rest.max_output_tokens || 8192,
        });

        const encoder = new TextEncoder();
        let sequenceNumber = 0;
        let fullText = "";

        const sseStream = new ReadableStream({
          async start(controller) {
            // 发送 response.created 事件
            const createdEvent = {
              type: "response.created",
              response: {
                id: responseId,
                object: "response",
                created_at: created,
                status: "in_progress",
                model: modelId,
                output: [],
                metadata: body.metadata || {},
                temperature: body.temperature ?? 1,
                top_p: body.top_p ?? 1,
                max_output_tokens: body.max_output_tokens,
                instructions: body.instructions || null,
                tools: body.tools || [],
                tool_choice: body.tool_choice || "auto",
              },
              sequence_number: sequenceNumber++,
            };
            controller.enqueue(
              encoder.encode(
                `event: response.created\ndata: ${JSON.stringify(createdEvent)}\n\n`,
              ),
            );

            // 发送 output_item.added 事件
            const outputItemAddedEvent = {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: messageId,
                role: "assistant",
                content: [],
                status: "in_progress",
              },
              sequence_number: sequenceNumber++,
            };
            controller.enqueue(
              encoder.encode(
                `event: response.output_item.added\ndata: ${JSON.stringify(outputItemAddedEvent)}\n\n`,
              ),
            );

            // 发送 content_part.added 事件
            const contentPartAddedEvent = {
              type: "response.content_part.added",
              output_index: 0,
              content_index: 0,
              part: {
                type: "output_text",
                text: "",
                annotations: [],
              },
              sequence_number: sequenceNumber++,
            };
            controller.enqueue(
              encoder.encode(
                `event: response.content_part.added\ndata: ${JSON.stringify(contentPartAddedEvent)}\n\n`,
              ),
            );

            try {
              // 处理文本流
              for await (const chunk of result.textStream) {
                fullText += chunk;
                const deltaEvent = {
                  type: "response.output_text.delta",
                  output_index: 0,
                  content_index: 0,
                  delta: chunk,
                  sequence_number: sequenceNumber++,
                };
                controller.enqueue(
                  encoder.encode(
                    `event: response.output_text.delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
                  ),
                );
              }

              // 获取 usage 信息
              const usage = await result.usage;

              // 发送 content_part.done 事件
              const contentPartDoneEvent = {
                type: "response.content_part.done",
                output_index: 0,
                content_index: 0,
                part: {
                  type: "output_text",
                  text: fullText,
                  annotations: [],
                },
                sequence_number: sequenceNumber++,
              };
              controller.enqueue(
                encoder.encode(
                  `event: response.content_part.done\ndata: ${JSON.stringify(contentPartDoneEvent)}\n\n`,
                ),
              );

              // 发送 output_item.done 事件
              const outputItemDoneEvent = {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "message",
                  id: messageId,
                  role: "assistant",
                  content: [
                    { type: "output_text", text: fullText, annotations: [] },
                  ],
                  status: "completed",
                },
                sequence_number: sequenceNumber++,
              };
              controller.enqueue(
                encoder.encode(
                  `event: response.output_item.done\ndata: ${JSON.stringify(outputItemDoneEvent)}\n\n`,
                ),
              );

              // 发送 response.completed 事件
              const completedEvent = {
                type: "response.completed",
                response: {
                  id: responseId,
                  object: "response",
                  created_at: created,
                  status: "completed",
                  model: modelId,
                  output: [
                    {
                      type: "message",
                      id: messageId,
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          text: fullText,
                          annotations: [],
                        },
                      ],
                      status: "completed",
                    },
                  ],
                  output_text: fullText,
                  usage: {
                    input_tokens: (usage as any).promptTokens || 0,
                    output_tokens: (usage as any).completionTokens || 0,
                    total_tokens: (usage as any).totalTokens || 0,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                  },
                  metadata: body.metadata || {},
                  temperature: body.temperature ?? 1,
                  top_p: body.top_p ?? 1,
                  max_output_tokens: body.max_output_tokens,
                  instructions: body.instructions || null,
                  tools: body.tools || [],
                  tool_choice: body.tool_choice || "auto",
                  error: null,
                  incomplete_details: null,
                },
                sequence_number: sequenceNumber++,
              };
              controller.enqueue(
                encoder.encode(
                  `event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`,
                ),
              );
              controller.close();
            } catch (error) {
              console.error("Stream error:", error);
              controller.error(error);
            }
          },
        });

        return new Response(sseStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        // 非流式响应
        const result = streamText({
          model: anthropic(modelId),
          messages,
          system,
          tools: aiSdkTools,
          temperature: rest.temperature,
          topP: rest.top_p,
          maxOutputTokens: rest.max_output_tokens || 8192,
        });

        const text = await result.text;
        const usage = await result.usage;

        const formattedResponse: ResponsesAPIResponse = {
          id: responseId,
          object: "response",
          created_at: created,
          status: "completed",
          model: modelId,
          output: [
            {
              type: "message",
              id: messageId,
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
              status: "completed",
            },
          ],
          output_text: text,
          usage: {
            input_tokens: (usage as any).promptTokens || 0,
            output_tokens: (usage as any).completionTokens || 0,
            total_tokens: (usage as any).totalTokens || 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
          error: null,
          incomplete_details: null,
          instructions: body.instructions || null,
          metadata: body.metadata || {},
          temperature: body.temperature ?? 1,
          top_p: body.top_p ?? 1,
          max_output_tokens: body.max_output_tokens,
          tools: body.tools || [],
          tool_choice: body.tool_choice || "auto",
          parallel_tool_calls: body.parallel_tool_calls ?? true,
          truncation: body.truncation || "disabled",
          previous_response_id: body.previous_response_id || null,
          reasoning: body.reasoning,
        };

        return c.json(formattedResponse);
      }
    } catch (error) {
      logError(endpoint, "POST", error);
      return c.json(
        {
          error: {
            code: "server_error",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        },
        500,
      );
    }
  });

  // 列出可用模型
  app.get("/v1/models", (c) => {
    return c.json({
      object: "list",
      data: [
        {
          id: "claude-sonnet-4-20250514",
          object: "model",
          owned_by: "anthropic",
        },
        {
          id: "claude-opus-4-20250514",
          object: "model",
          owned_by: "anthropic",
        },
        {
          id: "claude-3-5-sonnet-20241022",
          object: "model",
          owned_by: "anthropic",
        },
        {
          id: "claude-3-5-haiku-20241022",
          object: "model",
          owned_by: "anthropic",
        },
        {
          id: "claude-3-opus-20240229",
          object: "model",
          owned_by: "anthropic",
        },
      ],
    });
  });

  // 确保日志目录存在
  ensureLogDir();

  console.log(`CCProxy server starting on http://${host}:${port}`);
  console.log("Available endpoints:");
  console.log(`  - POST /v1/chat/completions (OpenAI Chat Completions API)`);
  console.log(`  - POST /v1/responses (OpenAI Responses API)`);
  console.log(`  - POST /v1/messages (Anthropic native)`);
  console.log(`  - GET  /v1/models`);
  console.log(`  - GET  /health`);
  console.log(`Logs directory: ${LOG_DIR}`);

  if (requireApiKey) {
    console.log(`API Key authentication: ENABLED`);
    console.log(
      `  Use 'Authorization: Bearer <api-key>' or 'x-api-key: <api-key>' header`,
    );
  } else {
    console.log(`API Key authentication: DISABLED (no API key configured)`);
    console.log(`  Generate one with: ccproxy apikey generate`);
  }

  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });
}
