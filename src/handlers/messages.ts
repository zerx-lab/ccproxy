/**
 * Anthropic Messages API 端点处理器
 * POST /v1/messages
 */

import type { Context } from "hono";
import { logRequest, logError } from "../logger";
import {
  processClaudeCodeRequestBody,
  removeToolPrefixFromResponse,
  sendClaudeCodeRequest,
} from "../utils/request-processor";
import { getValidAccessToken } from "../auth";

/**
 * 创建 Messages 请求处理器
 */
export function createMessagesHandler(mapModelName: (model: string) => string) {
  return async (c: Context) => {
    return handleMessagesInternal(c, mapModelName);
  };
}

/**
 * 处理 Messages 请求（内部实现）
 */
async function handleMessagesInternal(
  c: Context,
  mapModelName: (model: string) => string
) {
  const endpoint = "/v1/messages";
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      logError(endpoint, "POST", "Not authenticated");
      return c.json({ error: { message: "Not authenticated" } }, 401);
    }

    const body = await c.req.text();
    logRequest(endpoint, "POST", JSON.parse(body));

    // 解析请求体
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      logError(endpoint, "POST", "Invalid JSON in request body");
      return c.json(
        {
          error: {
            message: "Invalid JSON in request body",
            type: "invalid_request_error",
          },
        },
        400
      );
    }

    const isStreaming = parsed.stream === true;
    
    // 应用模型名称映射
    if (parsed.model) {
      parsed.model = mapModelName(parsed.model);
    }
    
    const processedBody = processClaudeCodeRequestBody(parsed);

    const response = await sendClaudeCodeRequest(
      accessToken,
      processedBody,
      isStreaming
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
      500
    );
  }
}

/**
 * 处理 Messages 请求（向后兼容，不进行模型映射）
 * @deprecated 请使用 createMessagesHandler
 */
export async function handleMessages(c: Context) {
  return handleMessagesInternal(c, (model) => model);
}
