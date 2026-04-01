/**
 * Claude Code 请求处理工具
 * 处理请求体转换、tool 名称前缀等
 */

import {
  TOOL_PREFIX,
  CLAUDE_CODE_SYSTEM_PROMPT,
  CLAUDE_CODE_HEADERS,
  DEFAULT_CLAUDE_CODE_TOOL,
} from "../constants";
import { writeLog } from "../logger";
import { forceRefreshAccessToken } from "../auth";

/** 请求处理选项 */
export interface ProcessRequestOptions {
  /** 是否启用 prompt 缓存（默认 true） */
  enablePromptCache?: boolean;
  /** 是否强制添加 placeholder 工具（默认 true，用于 /v1/messages 端点） */
  forceAddPlaceholderTool?: boolean;
  /** 缓存的消息数量（从最后开始，默认 3，与 opencode 保持一致） */
  cacheMessageCount?: number;
}

const DEFAULT_OPTIONS: ProcessRequestOptions = {
  enablePromptCache: true,
  forceAddPlaceholderTool: true,
  cacheMessageCount: 3,
};

/**
 * 检查工具名称是否已经有 mcp_ 前缀
 */
function hasToolPrefix(name: string): boolean {
  return name?.startsWith(TOOL_PREFIX) ?? false;
}

/**
 * 检查系统消息中是否已经包含完全相同的 Claude Code 系统提示词
 * 注意：必须精确匹配 CLAUDE_CODE_SYSTEM_PROMPT，而不是模糊匹配
 */
function hasExactClaudeCodeSystemPrompt(system: any): boolean {
  if (!system) return false;
  if (typeof system === "string") {
    return system === CLAUDE_CODE_SYSTEM_PROMPT;
  }
  if (Array.isArray(system)) {
    return system.some((item) =>
      typeof item === "string"
        ? item === CLAUDE_CODE_SYSTEM_PROMPT
        : item?.text === CLAUDE_CODE_SYSTEM_PROMPT,
    );
  }
  return false;
}

/**
 * 统一处理 Claude Code 代理请求体
 * - 添加 Claude Code system prompt（数组格式）
 * - 处理 tools 名称前缀和 input_schema（避免重复添加）
 * - 处理消息中的 tool_use blocks
 * - 添加 Anthropic prompt 缓存标记
 * - 可选：确保至少有一个带 mcp_ 前缀的 tool
 *
 * 注意：此函数设计为幂等的，多次调用不会重复添加前缀或系统消息
 */
export function processClaudeCodeRequestBody(
  body: any,
  options: ProcessRequestOptions = {},
): any {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parsed = typeof body === "string" ? JSON.parse(body) : { ...body };

  // 1. 添加 Claude Code system prompt（始终使用数组格式以匹配 Claude Code 实际格式）
  // 同时添加 cache_control 标记以启用 prompt 缓存
  // 注意：检查是否已经包含完全相同的 Claude Code 系统提示词，避免重复添加
  const cacheControl = opts.enablePromptCache
    ? { cache_control: { type: "ephemeral" } }
    : {};

  if (!hasExactClaudeCodeSystemPrompt(parsed.system)) {
    const claudeCodeSystemBlock = {
      type: "text",
      text: CLAUDE_CODE_SYSTEM_PROMPT,
      ...cacheControl,
    };

    if (!parsed.system) {
      parsed.system = [claudeCodeSystemBlock];
    } else if (typeof parsed.system === "string") {
      parsed.system = [
        claudeCodeSystemBlock,
        { type: "text", text: parsed.system },
      ];
    } else if (Array.isArray(parsed.system)) {
      parsed.system = [claudeCodeSystemBlock, ...parsed.system];
    }
  }

  // 2. 处理 tools - 添加名称前缀并确保 input_schema 格式正确
  // 注意：检查是否已经有 mcp_ 前缀，避免重复添加
  if (parsed.tools && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    // 检查是否至少有一个工具已经有 mcp_ 前缀（说明已经处理过）
    const alreadyProcessed = parsed.tools.some((tool: any) => {
      const name = tool.type === "custom" ? tool.custom?.name : tool.name;
      return hasToolPrefix(name);
    });

    if (!alreadyProcessed) {
      parsed.tools = parsed.tools.map((tool: any, index: number) => {
        // 判断是否给最后一个工具添加缓存标记
        const isLastTool = index === parsed.tools.length - 1;
        const toolCacheControl =
          opts.enablePromptCache && isLastTool ? cacheControl : {};

        // 处理 custom 类型的 tool（新格式）
        if (tool.type === "custom" && tool.custom) {
          return {
            ...tool,
            ...toolCacheControl,
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
          ...toolCacheControl,
          name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
        };
        // 确保 input_schema 有 type 字段
        if (result.input_schema) {
          result.input_schema = { type: "object", ...result.input_schema };
        }
        return result;
      });
    }
  } else if (opts.forceAddPlaceholderTool) {
    // 如果没有 tools 且需要强制添加，添加一个默认的 placeholder tool
    // 以确保请求被识别为 Claude Code 请求
    parsed.tools = [
      {
        ...DEFAULT_CLAUDE_CODE_TOOL,
        ...cacheControl,
      },
    ];
  }

  // 3. 处理消息中的 tool_use blocks，并添加缓存标记到最后几条消息
  // 注意：检查是否已经有 mcp_ 前缀，避免重复添加
  if (parsed.messages && Array.isArray(parsed.messages)) {
    const messageCount = parsed.messages.length;
    const cacheStartIndex = Math.max(
      0,
      messageCount - (opts.cacheMessageCount || 3),
    );

    parsed.messages = parsed.messages.map((msg: any, index: number) => {
      // 判断是否给这条消息添加缓存标记
      const shouldCache = opts.enablePromptCache && index >= cacheStartIndex;

      // 处理 tool_use blocks 中的工具名称前缀
      if (msg.content && Array.isArray(msg.content)) {
        msg.content = msg.content.map((block: any, blockIndex: number) => {
          if (block.type === "tool_use" && block.name) {
            // 检查是否已经有前缀
            if (!hasToolPrefix(block.name)) {
              return {
                ...block,
                name: `${TOOL_PREFIX}${block.name}`,
              };
            }
          }
          // 给最后一条消息的最后一个内容块添加缓存标记
          if (
            shouldCache &&
            index === messageCount - 1 &&
            blockIndex === msg.content.length - 1
          ) {
            return {
              ...block,
              ...cacheControl,
            };
          }
          return block;
        });
      } else if (shouldCache && typeof msg.content === "string") {
        // 对于字符串内容，需要转换为数组格式才能添加缓存标记
        msg.content = [
          {
            type: "text",
            text: msg.content,
            ...cacheControl,
          },
        ];
      }
      return msg;
    });
  }

  // 4. 强制限制 cache_control 块总数不超过 4（Anthropic API 限制）
  // opencode 客户端可能已经打了 cache_control，加上代理添加的会超出限制
  if (opts.enablePromptCache) {
    enforceCacheControlLimit(parsed, 4);
  }

  return parsed;
}

/**
 * 强制限制请求体中 cache_control 块的总数，超出部分从最早的位置移除
 * 顺序：system blocks → tools → messages（越早越先移除）
 */
function enforceCacheControlLimit(parsed: any, maxBlocks: number): void {
  // 收集所有带 cache_control 的位置（按优先级从低到高排列，低优先级先移除）
  const positions: Array<{ remove: () => void }> = [];

  // system blocks（最低优先级）
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block?.cache_control) {
        positions.push({ remove: () => delete block.cache_control });
      }
    }
  }

  // tools（次低优先级）
  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool?.cache_control) {
        positions.push({ remove: () => delete tool.cache_control });
      }
    }
  }

  // messages（最高优先级，最后移除）
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block?.cache_control) {
            positions.push({ remove: () => delete block.cache_control });
          }
        }
      }
    }
  }

  // 从低优先级开始移除，直到总数 <= maxBlocks
  const excess = positions.length - maxBlocks;
  for (let i = 0; i < excess; i++) {
    positions[i].remove();
  }
}

/**
 * 从响应文本中移除 tool 名称前缀
 */
export function removeToolPrefixFromResponse(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
}

/**
 * 发送 Claude Code API 请求
 * 纯透传代理：无超时、无重试，仅在 401 时刷新 token 并重试一次
 */
export async function sendClaudeCodeRequest(
  accessToken: string,
  body: any,
  stream: boolean = false,
): Promise<Response> {
  const url = new URL("https://api.anthropic.com/v1/messages");
  url.searchParams.set("beta", "true");

  // 注意：调用方应该已经使用 processClaudeCodeRequestBody 处理过 body
  // 这里不再重复处理，只负责发送请求
  const bodyStr = JSON.stringify(body);
  let currentToken = accessToken;

  const doFetch = async (token: string): Promise<Response> => {
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

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
        ...CLAUDE_CODE_HEADERS,
      },
      body: bodyStr,
    });

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
  };

  try {
    const response = await doFetch(currentToken);

    // 401：刷新 token 后重试一次（被动刷新策略）
    if (response.status === 401) {
      console.log(
        `[${new Date().toISOString()}] Received 401, attempting to refresh token...`,
      );
      const newToken = await forceRefreshAccessToken();
      if (newToken) {
        console.log(
          `[${new Date().toISOString()}] Token refreshed, retrying request...`,
        );
        return await doFetch(newToken);
      } else {
        console.error(
          `[${new Date().toISOString()}] Failed to refresh token, returning 401 response`,
        );
        return response;
      }
    }

    return response;
  } catch (error) {
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

/**
 * 创建自定义的 Anthropic fetch 函数，用于处理 OAuth 认证
 * 纯透传代理：无超时、无重试，仅在 401 时刷新 token 并重试一次，429/529 直接返回响应
 * @param getAccessToken - 获取访问令牌的函数
 * @param options - 请求处理选项
 */
export function createAuthenticatedFetch(
  getAccessToken: () => Promise<string | null>,
  options: ProcessRequestOptions = {},
) {
  const processOptions: ProcessRequestOptions = {
    enablePromptCache: true,
    forceAddPlaceholderTool: false,
    ...options,
  };

  return async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let accessToken = await getAccessToken();
    if (!accessToken) {
      throw new Error("Not authenticated. Please run 'ccproxy login' first.");
    }

    const requestInit = init ?? {};

    // 使用统一函数处理请求体
    let body = requestInit.body;
    if (body && typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        const processed = processClaudeCodeRequestBody(parsed, processOptions);
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

    const buildHeaders = (token: string): Headers => {
      const headers = new Headers(requestInit.headers);
      headers.set("authorization", `Bearer ${token}`);
      Object.entries(CLAUDE_CODE_HEADERS).forEach(([key, value]) => {
        headers.set(key, value);
      });
      headers.delete("x-api-key");
      return headers;
    };

    const doFetch = async (token: string): Promise<Response> => {
      const response = await fetch(requestInput, {
        ...requestInit,
        body,
        headers: buildHeaders(token),
      });
      return response;
    };

    const wrapResponse = (response: Response): Response => {
      if (!response.body) return response;

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
    };

    const response = await doFetch(accessToken);

    // 401：刷新 token 后重试一次（被动刷新策略）
    if (response.status === 401) {
      console.log(
        `[${new Date().toISOString()}] Received 401 in authenticated fetch, attempting to refresh token...`,
      );
      const newToken = await forceRefreshAccessToken();
      if (newToken) {
        console.log(
          `[${new Date().toISOString()}] Token refreshed, retrying request...`,
        );
        return wrapResponse(await doFetch(newToken));
      } else {
        console.error(
          `[${new Date().toISOString()}] Failed to refresh token, returning 401 response`,
        );
        return response;
      }
    }

    return wrapResponse(response);
  };
}
