/**
 * Claude Code 请求处理工具
 * 处理请求体转换、tool 名称前缀等
 */

import {
  TOOL_PREFIX,
  CLAUDE_CODE_SYSTEM_PROMPT,
  CLAUDE_CODE_HEADERS,
  DEFAULT_CLAUDE_CODE_TOOL,
  REQUEST_TIMEOUT,
} from "../constants";
import { writeLog } from "../logger";

/**
 * 统一处理 Claude Code 代理请求体
 * - 添加 Claude Code system prompt（数组格式）
 * - 处理 tools 名称前缀和 input_schema
 * - 处理消息中的 tool_use blocks
 * - 确保至少有一个带 mcp_ 前缀的 tool
 */
export function processClaudeCodeRequestBody(body: any): any {
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
export function removeToolPrefixFromResponse(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
}

/**
 * 发送 Claude Code API 请求
 */
export async function sendClaudeCodeRequest(
  accessToken: string,
  body: any,
  stream: boolean = false
): Promise<Response> {
  const url = new URL("https://api.anthropic.com/v1/messages");
  url.searchParams.set("beta", "true");

  // 注意：调用方应该已经使用 processClaudeCodeRequestBody 处理过 body
  // 这里不再重复处理，只负责发送请求
  const bodyStr = JSON.stringify(body);

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
    `[${new Date().toISOString()}] Sending request to Anthropic API (body size: ${bodyStr.length} bytes)`
  );

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

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
      `[${new Date().toISOString()}] Anthropic API response: ${response.status} ${response.statusText}`
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

/**
 * 创建自定义的 Anthropic fetch 函数，用于处理 OAuth 认证
 * @param getAccessToken - 获取访问令牌的函数
 */
export function createAuthenticatedFetch(
  getAccessToken: () => Promise<string | null>
) {
  return async (
    input: string | URL | globalThis.Request,
    init?: RequestInit
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
