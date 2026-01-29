/**
 * OpenAI Chat Completions API 端点处理器
 * POST /v1/chat/completions
 */

import type { Context } from "hono";
import { streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { logRequest, logError } from "../logger";
import { createAuthenticatedFetch } from "../utils/request-processor";
import {
  convertOpenAIToolsToAISDK,
  convertChatMessagesToAISDK,
  convertToolChoice,
} from "../utils/openai-converter";
import { getValidAccessToken } from "../auth";
import {
  createTrace,
  updateTrace,
  createGeneration,
  endGeneration,
  flushLangfuse,
  isLangfuseEnabled,
} from "../langfuse";
import { sessionManager } from "../session-manager";

/**
 * 处理 Chat Completions 请求
 */
export function createChatCompletionsHandler(
  mapModelName: (model: string) => string,
) {
  return async (c: Context) => {
    const endpoint = "/v1/chat/completions";
    let sessionId: string | null = null;

    // Langfuse tracing
    const trace = isLangfuseEnabled()
      ? createTrace({
          name: "chat-completions",
          metadata: {
            endpoint,
            userAgent: c.req.header("user-agent"),
          },
        })
      : null;
    let generation: ReturnType<typeof createGeneration> | null = null;

    try {
      const body = await c.req.json();

      // 会话管理：提取会话 ID 并检查是否可以处理请求
      // 将 OpenAI 格式转换为类似 Anthropic 格式以便 sessionManager 处理
      const sessionBody = { messages: body.messages };
      sessionId = sessionManager.extractSessionId(sessionBody);
      const requestStatus = sessionManager.startRequest(sessionId, body);

      if (!requestStatus.accepted) {
        console.warn(`[chat-completions] Request rejected: ${requestStatus.reason}`);
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
      logRequest(endpoint, "POST", body);
      const {
        model,
        messages: openaiMessages,
        tools: openaiTools,
        tool_choice: openaiToolChoice,
        stream = false,
        max_tokens,
        max_completion_tokens,
        stop,
        temperature,
        top_p,
        parallel_tool_calls,
        prompt_cache_key, // OpenAI 缓存参数，映射到 Anthropic cacheControl
        ...rest
      } = body;

      // 转换消息格式（处理 system、tool 消息、tool_calls）
      const { messages, system } = convertChatMessagesToAISDK(openaiMessages);

      // 调试日志：显示转换后的消息格式
      console.log(
        `[chat-completions] Converted messages:`,
        JSON.stringify(messages, null, 2),
      );
      if (system) {
        console.log(
          `[chat-completions] System prompt length: ${system.length}`,
        );
      }

      // 将 OpenAI 格式的 tools 转换为 AI SDK 格式
      const aiSdkTools =
        openaiTools && Array.isArray(openaiTools) && openaiTools.length > 0
          ? convertOpenAIToolsToAISDK(openaiTools)
          : undefined;

      // 转换 tool_choice
      let toolChoice = convertToolChoice(openaiToolChoice);

      // 验证 tools 和 toolChoice 的组合
      // 如果没有 tools，toolChoice 应该是 undefined 或 "none"
      if (!aiSdkTools || Object.keys(aiSdkTools).length === 0) {
        if (toolChoice && toolChoice !== "none") {
          console.warn(
            `[chat-completions] No tools provided but toolChoice is "${JSON.stringify(toolChoice)}", setting to undefined`,
          );
          toolChoice = undefined;
        }
      }

      // 如果 toolChoice 指定了特定工具，验证该工具存在
      if (
        aiSdkTools &&
        typeof toolChoice === "object" &&
        toolChoice?.type === "tool" &&
        toolChoice?.toolName
      ) {
        if (!aiSdkTools[toolChoice.toolName]) {
          console.warn(
            `[chat-completions] toolChoice specifies non-existent tool "${toolChoice.toolName}", available tools: [${Object.keys(aiSdkTools).join(", ")}], setting to "auto"`,
          );
          toolChoice = "auto";
        }
      }

      console.log(
        `[chat-completions] Final toolChoice: ${JSON.stringify(toolChoice)}, tools count: ${aiSdkTools ? Object.keys(aiSdkTools).length : 0}`,
      );

      // 创建带认证的 Anthropic 客户端
      const anthropic = createAnthropic({
        apiKey: "", // 使用自定义 fetch，不需要 API key
        fetch: createAuthenticatedFetch(getValidAccessToken) as typeof fetch,
      });

      // 映射模型名称
      const modelId = mapModelName(model);

      // 更新 trace 的 input（在解析请求后设置）
      if (trace) {
        updateTrace(trace, {
          input: {
            messages: openaiMessages,
            tools: openaiTools,
            tool_choice: openaiToolChoice,
            model,
            temperature,
            top_p,
            max_tokens: max_completion_tokens || max_tokens,
            stream,
          },
        });
      }

      // 创建 Langfuse generation
      if (trace) {
        generation = createGeneration({
          trace,
          name: "llm-call",
          model: modelId,
          input: {
            messages: openaiMessages,
            tools: openaiTools,
            tool_choice: openaiToolChoice,
            temperature,
            top_p,
            max_tokens: max_completion_tokens || max_tokens,
            stream,
          },
          metadata: {
            originalModel: model,
            mappedModel: modelId,
          },
        });
      }

      // 构建 AI SDK 参数
      const maxTokens = max_completion_tokens || max_tokens;
      const stopSequences = stop
        ? Array.isArray(stop)
          ? stop
          : [stop]
        : undefined;

      if (stream) {
        // 流式响应 - OpenAI 兼容格式
        const encoder = new TextEncoder();
        const chatId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        // 用于跟踪工具调用
        const toolCallsMap = new Map<
          string,
          { name: string; arguments: string }
        >();
        let toolCallIndex = 0;
        // 用于收集完整的响应文本（用于 Langfuse trace output）
        let fullResponseText = "";

        // 辅助函数：创建 SSE 错误响应
        const createSSEErrorResponse = (errorMessage: string) => {
          const errorData = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "error",
              },
            ],
            error: {
              message: errorMessage,
              type: "api_error",
            },
          };
          return `data: ${JSON.stringify(errorData)}\n\ndata: [DONE]\n\n`;
        };

        // 用于存储流式处理中捕获的错误
        let streamError: Error | null = null;

        // 在创建流之前先尝试初始化 streamText，以便捕获初始化错误
        let result;
        try {
          result = streamText({
            model: anthropic(modelId),
            messages,
            system,
            tools: aiSdkTools,
            toolChoice,
            temperature,
            topP: top_p,
            maxOutputTokens: maxTokens,
            stopSequences,
            // 传递 Anthropic provider 选项
            providerOptions: {
              anthropic: {
                // parallel_tool_calls: true (OpenAI) -> disableParallelToolUse: false (Anthropic)
                // parallel_tool_calls: false (OpenAI) -> disableParallelToolUse: true (Anthropic)
                ...(parallel_tool_calls !== undefined && {
                  disableParallelToolUse: !parallel_tool_calls,
                }),
                // 当有 prompt_cache_key 时，启用 Anthropic 缓存
                // 注意：OpenAI 和 Anthropic 的缓存机制不同，这是一个近似映射
                ...(prompt_cache_key && {
                  cacheControl: { type: "ephemeral" as const },
                }),
              },
            },
            // 添加 onError 回调来捕获流式错误（AI SDK 6.x 会抑制错误以防止服务器崩溃）
            onError({ error }) {
              console.error("[chat-completions] Stream error captured:", error);
              streamError =
                error instanceof Error ? error : new Error(String(error));
              logError(endpoint, "POST", error);
            },
          });
        } catch (initError) {
          // 初始化错误 - 返回 SSE 格式的错误响应
          const errorMessage =
            initError instanceof Error ? initError.message : "Unknown error";
          logError(endpoint, "POST", initError);
          const errorStream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(createSSEErrorResponse(errorMessage)),
              );
              controller.close();
            },
          });
          return new Response(errorStream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        const sseStream = new ReadableStream({
          async start(controller) {
            try {
              // 使用 fullStream 以获取所有类型的事件（包括工具调用）
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") {
                  // 文本增量 - AI SDK 6.x 使用 'text' 而不是 'textDelta'
                  const textContent = (part as any).text || (part as any).textDelta;
                  // 收集完整的响应文本
                  fullResponseText += textContent || "";
                  const data = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelId,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: textContent,
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
                  );
                } else if (part.type === "tool-call") {
                  // 工具调用 - 发送完整的工具调用信息
                  // AI SDK 6.x 使用 'input' 而不是 'args'
                  const toolArgs = (part as any).args || (part as any).input;
                  const toolCall = {
                    index: toolCallIndex++,
                    id: part.toolCallId,
                    type: "function",
                    function: {
                      name: part.toolName,
                      arguments: JSON.stringify(toolArgs),
                    },
                  };

                  const data = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelId,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [toolCall],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
                  );

                  toolCallsMap.set(part.toolCallId, {
                    name: part.toolName,
                    arguments: JSON.stringify(toolArgs),
                  });
                } else if (part.type === "error") {
                  // 处理流式错误事件（AI SDK 6.x 中 error 作为 stream part 发送）
                  const errorMessage =
                    part.error instanceof Error
                      ? part.error.message
                      : String(part.error);
                  console.error(
                    "[chat-completions] Stream error part:",
                    errorMessage,
                  );
                  logError(endpoint, "POST", part.error);
                  controller.enqueue(
                    encoder.encode(createSSEErrorResponse(errorMessage)),
                  );
                  // 不要 close，让流继续处理可能的 finish 事件
                } else if (part.type === "finish") {
                  // 完成事件 - 确定正确的 finish_reason
                  // 如果有错误，使用 "error" 作为 finish_reason
                  const finishReason = streamError
                    ? "error"
                    : toolCallsMap.size > 0
                      ? "tool_calls"
                      : "stop";
                  const doneData = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelId,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: finishReason,
                      },
                    ],
                    // 如果有错误，添加到响应中
                    ...(streamError && {
                      error: {
                        message: streamError.message,
                        type: "api_error",
                      },
                    }),
                  };
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(doneData)}\n\n`),
                  );
                }
              }

              // 流式响应完成，更新 trace output 并结束 Langfuse generation
              const streamOutput = {
                content: fullResponseText || null,
                finish_reason: streamError
                  ? "error"
                  : toolCallsMap.size > 0
                    ? "tool_calls"
                    : "stop",
                tool_calls:
                  toolCallsMap.size > 0
                    ? Array.from(toolCallsMap.entries()).map(
                        ([id, { name, arguments: args }]) => ({
                          id,
                          type: "function",
                          function: { name, arguments: args },
                        }),
                      )
                    : undefined,
              };

              if (trace) {
                updateTrace(trace, { output: streamOutput });
              }

              if (generation) {
                const usage = await result.usage;
                // AI SDK v6 使用 inputTokens/outputTokens 而不是 promptTokens/completionTokens
                endGeneration({
                  generation,
                  output: streamOutput,
                  usage: {
                    promptTokens: (usage as any)?.inputTokens || 0,
                    completionTokens: (usage as any)?.outputTokens || 0,
                    totalTokens: (usage as any)?.totalTokens || 0,
                  },
                  level: streamError ? "ERROR" : "DEFAULT",
                  statusMessage: streamError?.message,
                });
                flushLangfuse();
              }

              // 结束会话跟踪
              if (sessionId) {
                sessionManager.endRequest(sessionId);
              }

              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch (error) {
              // 流式处理中的错误 - 发送 SSE 格式的错误响应而不是断开连接
              console.error("Stream error:", error);
              const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
              logError(endpoint, "POST", error);

              // 结束会话跟踪
              if (sessionId) {
                sessionManager.endRequest(sessionId);
              }

              try {
                controller.enqueue(
                  encoder.encode(createSSEErrorResponse(errorMessage)),
                );
                controller.close();
              } catch (enqueueError) {
                // 如果无法发送错误响应，则断开连接
                controller.error(error);
              }
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
          toolChoice,
          temperature,
          topP: top_p,
          maxOutputTokens: maxTokens,
          stopSequences,
          // 传递 Anthropic provider 选项
          providerOptions: {
            anthropic: {
              ...(parallel_tool_calls !== undefined && {
                disableParallelToolUse: !parallel_tool_calls,
              }),
              ...(prompt_cache_key && {
                cacheControl: { type: "ephemeral" as const },
              }),
            },
          },
        });

        const text = await result.text;
        const usage = await result.usage;
        const toolCalls = await result.toolCalls;

        // 构建响应消息
        const message: any = {
          role: "assistant",
          content: text || null,
        };

        // 如果有工具调用，添加到消息中
        if (toolCalls && toolCalls.length > 0) {
          message.tool_calls = toolCalls.map((tc: any, index: number) => ({
            id: tc.toolCallId,
            type: "function",
            function: {
              name: tc.toolName,
              // AI SDK 6.x 使用 'input' 而不是 'args'
              arguments: JSON.stringify(tc.args || tc.input),
            },
          }));
        }

        const finishReason =
          toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop";

        // 非流式响应完成，结束 Langfuse generation 并更新 trace output
        if (trace) {
          updateTrace(trace, {
            output: {
              content: text,
              tool_calls: message.tool_calls,
              finish_reason: finishReason,
            },
          });
        }
        if (generation) {
          endGeneration({
            generation,
            output: {
              content: text,
              tool_calls: message.tool_calls,
              finish_reason: finishReason,
            },
            usage: {
              promptTokens: (usage as any).inputTokens || 0,
              completionTokens: (usage as any).outputTokens || 0,
              totalTokens: (usage as any).totalTokens || 0,
            },
          });
          flushLangfuse();
        }

        // 结束会话跟踪
        if (sessionId) {
          sessionManager.endRequest(sessionId);
        }

        return c.json({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message,
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: (usage as any).inputTokens || 0,
            completion_tokens: (usage as any).outputTokens || 0,
            total_tokens: (usage as any).totalTokens || 0,
          },
        });
      }
    } catch (error) {
      // 结束会话跟踪
      if (sessionId) {
        sessionManager.endRequest(sessionId);
      }

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
  };
}
