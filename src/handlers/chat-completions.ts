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

/**
 * 处理 Chat Completions 请求
 */
export function createChatCompletionsHandler(
  mapModelName: (model: string) => string,
) {
  return async (c: Context) => {
    const endpoint = "/v1/chat/completions";
    try {
      const body = await c.req.json();
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
      const toolChoice = convertToolChoice(openaiToolChoice);

      // 创建带认证的 Anthropic 客户端
      const anthropic = createAnthropic({
        apiKey: "", // 使用自定义 fetch，不需要 API key
        fetch: createAuthenticatedFetch(getValidAccessToken) as typeof fetch,
      });

      // 映射模型名称
      const modelId = mapModelName(model);

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
                  const data = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelId,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content:
                            (part as any).text || (part as any).textDelta,
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

              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch (error) {
              // 流式处理中的错误 - 发送 SSE 格式的错误响应而不是断开连接
              console.error("Stream error:", error);
              const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
              logError(endpoint, "POST", error);
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
  };
}
