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
import { sessionManager } from "../session-manager";
import {
  createTrace,
  updateTrace,
  createGeneration,
  endGeneration,
  flushLangfuse,
  isLangfuseEnabled,
} from "../langfuse";

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
  let sessionId: string | null = null;

  // Langfuse tracing
  const trace = isLangfuseEnabled()
    ? createTrace({
        name: "messages",
        metadata: {
          endpoint,
          userAgent: c.req.header("user-agent"),
        },
      })
    : null;
  let generation: ReturnType<typeof createGeneration> | null = null;

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

    // 会话管理：提取会话 ID 并检查是否可以处理请求
    sessionId = sessionManager.extractSessionId(parsed);
    const requestStatus = sessionManager.startRequest(sessionId, parsed);

    if (!requestStatus.accepted) {
      console.warn(`[messages] Request rejected: ${requestStatus.reason}`);
      return c.json(
        {
          error: {
            message: requestStatus.reason,
            type: "rate_limit_error",
          },
        },
        429
      );
    }

    const isStreaming = parsed.stream === true;
    const originalModel = parsed.model;

    // 应用模型名称映射
    if (parsed.model) {
      parsed.model = mapModelName(parsed.model);
    }
    const modelId = parsed.model;

    // 更新 trace 的 input 并创建 generation
    if (trace) {
      updateTrace(trace, {
        input: {
          model: originalModel,
          messages: parsed.messages,
          system: parsed.system,
          tools: parsed.tools,
          tool_choice: parsed.tool_choice,
          max_tokens: parsed.max_tokens,
          temperature: parsed.temperature,
          top_p: parsed.top_p,
          stream: isStreaming,
        },
      });

      generation = createGeneration({
        trace,
        name: "llm-call",
        model: modelId,
        input: {
          messages: parsed.messages,
          system: parsed.system,
          tools: parsed.tools,
          tool_choice: parsed.tool_choice,
          max_tokens: parsed.max_tokens,
          temperature: parsed.temperature,
          top_p: parsed.top_p,
          stream: isStreaming,
        },
        metadata: {
          originalModel,
          mappedModel: modelId,
        },
      });
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
      const currentSessionId = sessionId; // 捕获到闭包中
      const currentTrace = trace; // 捕获到闭包中
      const currentGeneration = generation; // 捕获到闭包中

      // 用于收集流式响应的 usage 和内容
      let inputTokens = 0;
      let outputTokens = 0;
      let fullContent = "";
      let stopReason = "";
      let sseBuffer = ""; // SSE 解析缓冲区

      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            // 流结束，更新 trace 和 generation
            const streamOutput = {
              content: fullContent || null,
              stop_reason: stopReason || "end_turn",
            };

            if (currentTrace) {
              updateTrace(currentTrace, { output: streamOutput });
            }

            if (currentGeneration) {
              endGeneration({
                generation: currentGeneration,
                output: streamOutput,
                usage: {
                  promptTokens: inputTokens,
                  completionTokens: outputTokens,
                  totalTokens: inputTokens + outputTokens,
                },
              });
              flushLangfuse();
            }

            // 结束会话跟踪
            if (currentSessionId) {
              sessionManager.endRequest(currentSessionId);
            }
            controller.close();
            return;
          }

          let text = decoder.decode(value, { stream: true });

          // 解析 SSE 事件以提取 usage 信息
          sseBuffer += text;
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() || ""; // 保留不完整的行

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const dataStr = line.slice(6);
              if (dataStr === "[DONE]") continue;

              try {
                const event = JSON.parse(dataStr);

                // message_start 事件包含 input_tokens
                if (event.type === "message_start" && event.message?.usage) {
                  inputTokens = event.message.usage.input_tokens || 0;
                }

                // message_delta 事件包含 output_tokens
                if (event.type === "message_delta" && event.usage) {
                  outputTokens = event.usage.output_tokens || 0;
                  if (event.delta?.stop_reason) {
                    stopReason = event.delta.stop_reason;
                  }
                }

                // content_block_delta 事件包含文本内容
                if (event.type === "content_block_delta" && event.delta?.text) {
                  fullContent += event.delta.text;
                }
              } catch {
                // JSON 解析失败，忽略
              }
            }
          }

          text = removeToolPrefixFromResponse(text);
          controller.enqueue(encoder.encode(text));
        },
        cancel() {
          // 客户端断开连接时结束会话跟踪和 Langfuse
          if (currentGeneration) {
            endGeneration({
              generation: currentGeneration,
              output: { content: fullContent || null, cancelled: true },
              usage: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
              },
              level: "WARNING",
              statusMessage: "Client disconnected",
            });
            flushLangfuse();
          }

          if (currentSessionId) {
            sessionManager.endRequest(currentSessionId);
          }
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

    // 解析响应以获取 Langfuse 需要的数据
    let responseData: any = null;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      // 解析失败，忽略
    }

    // 更新 trace output 并结束 generation
    if (responseData) {
      const output = {
        content: responseData.content,
        stop_reason: responseData.stop_reason,
        model: responseData.model,
      };

      if (trace) {
        updateTrace(trace, { output });
      }

      if (generation) {
        // Anthropic 使用 input_tokens/output_tokens 格式
        const usage = responseData.usage;
        endGeneration({
          generation,
          output,
          usage: usage ? {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          } : undefined,
        });
        flushLangfuse();
      }
    }

    // 结束会话跟踪
    if (sessionId) {
      sessionManager.endRequest(sessionId);
    }

    return new Response(responseText, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    // 错误时结束 Langfuse generation
    if (generation) {
      endGeneration({
        generation,
        output: { error: error instanceof Error ? error.message : "Unknown error" },
        level: "ERROR",
        statusMessage: error instanceof Error ? error.message : "Unknown error",
      });
      flushLangfuse();
    }

    // 结束会话跟踪
    if (sessionId) {
      sessionManager.endRequest(sessionId);
    }

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
