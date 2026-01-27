/**
 * OpenAI Responses API 端点处理器
 * POST /v1/responses
 */

import type { Context } from "hono";
import { streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { logRequest, logError } from "../logger";
import { createAuthenticatedFetch } from "../utils/request-processor";
import {
  convertOpenAIToolsToAISDK,
  convertResponsesInputToAISDK,
  convertToolChoice,
} from "../utils/openai-converter";
import { getValidAccessToken } from "../auth";
import type { ResponsesAPIRequest, ResponsesAPIResponse } from "../types";

/**
 * 处理 Responses API 请求
 */
export function createResponsesHandler(
  mapModelName: (model: string) => string,
) {
  return async (c: Context) => {
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

      // 调试：打印转换后的消息结构
      console.log("[DEBUG] Converted messages structure:");
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        let info = `  [${i}] role=${msg.role}`;
        if (Array.isArray(msg.content)) {
          info += `, content=[${msg.content.map((c: any) => c.type + (c.toolCallId ? ":" + c.toolCallId : "")).join(", ")}]`;
        } else if (typeof msg.content === "string") {
          info += `, content="${msg.content.substring(0, 30)}..."`;
        }
        console.log(info);
      }
      console.log("[DEBUG] Input structure:");
      for (let i = 0; i < (input as any[]).length; i++) {
        const item = (input as any[])[i];
        let info = `  [${i}] type=${item.type}`;
        if (item.role) info += `, role=${item.role}`;
        if (item.call_id) info += `, call_id=${item.call_id}`;
        if (item.name) info += `, name=${item.name}`;
        console.log(info);
      }

      // 转换 tools 为 AI SDK 格式
      const aiSdkTools =
        openaiTools && Array.isArray(openaiTools) && openaiTools.length > 0
          ? convertOpenAIToolsToAISDK(openaiTools)
          : undefined;

      // 转换 tool_choice
      const toolChoice = convertToolChoice(body.tool_choice);

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
        const encoder = new TextEncoder();
        let sequenceNumber = 0;
        let fullText = "";

        // 辅助函数：创建 SSE 错误响应
        const createSSEErrorResponse = (errorMessage: string) => {
          const errorEvent = {
            type: "response.error",
            response: {
              id: responseId,
              object: "response",
              created_at: created,
              status: "failed",
              model: modelId,
              output: [],
              error: {
                code: "api_error",
                message: errorMessage,
              },
            },
            sequence_number: sequenceNumber++,
          };
          return `event: response.error\ndata: ${JSON.stringify(errorEvent)}\n\n`;
        };

        // 在创建流之前先尝试初始化 streamText，以便捕获初始化错误
        let result;
        try {
          result = streamText({
            model: anthropic(modelId),
            messages,
            system,
            tools: aiSdkTools,
            toolChoice,
            temperature: rest.temperature,
            topP: rest.top_p,
            maxOutputTokens: rest.max_output_tokens || 8192,
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

            // 跟踪输出项
            let outputIndex = 0;
            let hasTextContent = false;
            let textContentIndex = 0;
            const toolCalls: any[] = [];

            try {
              // 使用 fullStream 以获取所有类型的事件（包括工具调用）
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") {
                  // 首次收到文本时，发送 message output_item.added 和 content_part.added
                  if (!hasTextContent) {
                    hasTextContent = true;

                    // 发送 output_item.added 事件 (message)
                    const outputItemAddedEvent = {
                      type: "response.output_item.added",
                      output_index: outputIndex,
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
                      output_index: outputIndex,
                      content_index: textContentIndex,
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
                  }

                  // 文本增量
                  const textDelta =
                    (part as any).text || (part as any).textDelta;
                  fullText += textDelta;
                  const deltaEvent = {
                    type: "response.output_text.delta",
                    output_index: outputIndex,
                    content_index: textContentIndex,
                    delta: textDelta,
                    sequence_number: sequenceNumber++,
                  };
                  controller.enqueue(
                    encoder.encode(
                      `event: response.output_text.delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
                    ),
                  );
                } else if (part.type === "tool-call") {
                  // 工具调用
                  const toolArgs = (part as any).args || (part as any).input;
                  const toolCallId = part.toolCallId;
                  const toolOutputIndex = hasTextContent
                    ? outputIndex + 1 + toolCalls.length
                    : outputIndex + toolCalls.length;

                  const toolCallItem = {
                    type: "function_call",
                    id: toolCallId,
                    call_id: toolCallId,
                    name: part.toolName,
                    arguments: JSON.stringify(toolArgs),
                    status: "completed",
                  };
                  toolCalls.push(toolCallItem);

                  // 发送 function_call output_item.added 事件
                  const toolOutputItemAddedEvent = {
                    type: "response.output_item.added",
                    output_index: toolOutputIndex,
                    item: toolCallItem,
                    sequence_number: sequenceNumber++,
                  };
                  controller.enqueue(
                    encoder.encode(
                      `event: response.output_item.added\ndata: ${JSON.stringify(toolOutputItemAddedEvent)}\n\n`,
                    ),
                  );

                  // 发送 function_call_arguments.done 事件
                  const argsEvent = {
                    type: "response.function_call_arguments.done",
                    output_index: toolOutputIndex,
                    call_id: toolCallId,
                    name: part.toolName,
                    arguments: JSON.stringify(toolArgs),
                    sequence_number: sequenceNumber++,
                  };
                  controller.enqueue(
                    encoder.encode(
                      `event: response.function_call_arguments.done\ndata: ${JSON.stringify(argsEvent)}\n\n`,
                    ),
                  );

                  // 发送 output_item.done 事件
                  const toolOutputItemDoneEvent = {
                    type: "response.output_item.done",
                    output_index: toolOutputIndex,
                    item: toolCallItem,
                    sequence_number: sequenceNumber++,
                  };
                  controller.enqueue(
                    encoder.encode(
                      `event: response.output_item.done\ndata: ${JSON.stringify(toolOutputItemDoneEvent)}\n\n`,
                    ),
                  );
                } else if (part.type === "finish") {
                  // 完成事件
                  const usage = await result.usage;

                  // 如果有文本内容，先完成文本部分
                  if (hasTextContent) {
                    // 发送 content_part.done 事件
                    const contentPartDoneEvent = {
                      type: "response.content_part.done",
                      output_index: outputIndex,
                      content_index: textContentIndex,
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

                    // 发送 output_item.done 事件 (message)
                    const outputItemDoneEvent = {
                      type: "response.output_item.done",
                      output_index: outputIndex,
                      item: {
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
                      sequence_number: sequenceNumber++,
                    };
                    controller.enqueue(
                      encoder.encode(
                        `event: response.output_item.done\ndata: ${JSON.stringify(outputItemDoneEvent)}\n\n`,
                      ),
                    );
                  }

                  // 构建最终输出数组
                  const finalOutput: any[] = [];
                  if (hasTextContent) {
                    finalOutput.push({
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
                    });
                  }
                  finalOutput.push(...toolCalls);

                  // 发送 response.completed 事件
                  const completedEvent = {
                    type: "response.completed",
                    response: {
                      id: responseId,
                      object: "response",
                      created_at: created,
                      status: "completed",
                      model: modelId,
                      output: finalOutput,
                      output_text: fullText || null,
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
                }
              }

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
          temperature: rest.temperature,
          topP: rest.top_p,
          maxOutputTokens: rest.max_output_tokens || 8192,
        });

        const text = await result.text;
        const usage = await result.usage;
        const toolCalls = await result.toolCalls;

        // 构建输出数组
        const output: any[] = [];

        // 如果有文本内容，添加 message 输出
        if (text) {
          output.push({
            type: "message",
            id: messageId,
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
            status: "completed",
          });
        }

        // 如果有工具调用，添加 function_call 输出
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const toolArgs = (tc as any).args || (tc as any).input;
            output.push({
              type: "function_call",
              id: (tc as any).toolCallId,
              call_id: (tc as any).toolCallId,
              name: (tc as any).toolName,
              arguments: JSON.stringify(toolArgs),
              status: "completed",
            });
          }
        }

        const formattedResponse: ResponsesAPIResponse = {
          id: responseId,
          object: "response",
          created_at: created,
          status: "completed",
          model: modelId,
          output: output as any,
          output_text: text || undefined,
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
  };
}
