/**
 * OpenAI 格式转换工具
 * 处理 OpenAI Chat Completions 和 Responses API 格式转换
 */

import { jsonSchema, tool } from "ai";
import type { ResponseInputItem } from "../types";

/**
 * 将 OpenAI Chat Completions 格式的消息转换为 AI SDK 格式
 * 处理：system 消息提取、tool 消息转换、tool_calls 转换、多模态内容
 */
export function convertChatMessagesToAISDK(messages: any[]): {
  messages: any[];
  system?: string;
} {
  let system: string | undefined;
  const convertedMessages: any[] = [];

  // 用于跟踪工具调用信息（tool_call_id -> toolName）
  const toolCallInfo: Map<string, string> = new Map();

  // 第一遍：收集所有 tool_calls 信息
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallInfo.set(tc.id, tc.function?.name || "unknown");
      }
    }
  }

  // 第二遍：转换消息
  for (const msg of messages) {
    try {
      // 处理 system 消息
      if (msg.role === "system") {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : (msg.content || []).map((p: any) => p.text || "").join("");
        if (text.trim()) {
          system = system ? `${system}\n\n${text}` : text;
        }
        continue;
      }

      // 处理 user 消息
      if (msg.role === "user") {
        let content: any;
        if (typeof msg.content === "string") {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // 转换多模态内容
          // 注意：Anthropic API 要求 text 内容块必须包含非空白文本
          const parts: any[] = [];
          for (const part of msg.content) {
            if (part.type === "text" && part.text && part.text.trim()) {
              parts.push({ type: "text", text: part.text });
            } else if (part.type === "image_url" && part.image_url) {
              // OpenAI 图片格式 -> AI SDK 格式
              const url = part.image_url.url || part.image_url;
              parts.push({ type: "image", image: url });
            }
          }
          content =
            parts.length === 1 && parts[0].type === "text"
              ? parts[0].text
              : parts;
        }
        if (content) {
          convertedMessages.push({ role: "user", content });
        }
        continue;
      }

      // 处理 assistant 消息
      if (msg.role === "assistant") {
        const contentParts: any[] = [];

        // 处理文本内容（可能是 null、undefined、字符串或数组）
        // 注意：Anthropic API 要求 text 内容块必须包含非空白文本
        if (msg.content) {
          if (typeof msg.content === "string" && msg.content.trim()) {
            contentParts.push({ type: "text", text: msg.content });
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text && part.text.trim()) {
                contentParts.push({ type: "text", text: part.text });
              }
            }
          }
        }

        // 处理 tool_calls
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let input = {};
            try {
              input =
                typeof tc.function?.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function?.arguments || {};
            } catch (e) {
              console.error(
                "[convertChatMessagesToAISDK] Failed to parse tool arguments:",
                e,
              );
              input = {};
            }
            // AI SDK 6.x 使用 'input' 而不是 'args'
            contentParts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.function?.name || "unknown",
              input,
            });
          }
        }

        if (contentParts.length > 0) {
          convertedMessages.push({ role: "assistant", content: contentParts });
        }
        continue;
      }

      // 处理 tool 消息（工具调用结果）
      // 注意：需要将连续的 tool 消息合并到一个消息中，因为 Anthropic 要求
      // tool_result 必须在包含对应 tool_use 的 assistant 消息之后
      if (msg.role === "tool") {
        const toolCallId = msg.tool_call_id;
        const toolName = toolCallInfo.get(toolCallId) || "unknown";

        // AI SDK 6.x 的 ToolResultOutput 格式：{ type: 'text', value: string }
        const outputValue =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);

        const toolResult = {
          type: "tool-result",
          toolCallId: toolCallId,
          toolName: toolName,
          output: {
            type: "text",
            value: outputValue,
          },
        };

        // 检查前一条消息是否是 tool 消息，如果是则合并
        const lastMessage = convertedMessages[convertedMessages.length - 1];
        if (lastMessage && lastMessage.role === "tool") {
          // 合并到前一个 tool 消息中
          lastMessage.content.push(toolResult);
        } else {
          // 创建新的 tool 消息
          convertedMessages.push({
            role: "tool",
            content: [toolResult],
          });
        }
        continue;
      }

      // 未知角色，记录警告
      console.warn(`[convertChatMessagesToAISDK] Unknown role: ${msg.role}`);
    } catch (error) {
      console.error(
        `[convertChatMessagesToAISDK] Error processing message:`,
        error,
        msg,
      );
    }
  }

  console.log(
    `[convertChatMessagesToAISDK] Converted ${messages.length} messages to ${convertedMessages.length} messages`,
  );

  return { messages: convertedMessages, system };
}

/**
 * 转换 OpenAI tool_choice 到 AI SDK 格式
 *
 * OpenAI 格式:
 *   - "none" | "auto" | "required"
 *   - { type: "function", function: { name: "xxx" } }  // 强制调用特定工具
 *   - { type: "function" }  // 等同于 "required"
 *   - { type: "any" }  // 等同于 "required" (某些客户端可能使用)
 *
 * AI SDK 格式:
 *   - "none" | "auto" | "required"
 *   - { type: "tool", toolName: "xxx" }
 */
export function convertToolChoice(toolChoice: any): any {
  if (!toolChoice) return undefined;

  // 字符串格式：直接返回
  if (typeof toolChoice === "string") {
    // 确保是有效的字符串值
    if (["none", "auto", "required"].includes(toolChoice)) {
      return toolChoice;
    }
    // 某些客户端可能发送 "any"，映射到 "required"
    if (toolChoice === "any") {
      console.log(
        `[convertToolChoice] Mapping "any" to "required"`,
      );
      return "required";
    }
    console.warn(
      `[convertToolChoice] Unknown string tool_choice: "${toolChoice}", defaulting to "auto"`,
    );
    return "auto";
  }

  // 对象格式
  if (typeof toolChoice === "object") {
    // { type: "function", function: { name: "xxx" } } -> { type: "tool", toolName: "xxx" }
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "tool", toolName: toolChoice.function.name };
    }

    // { type: "function" } (没有 function.name) -> "required"
    if (toolChoice.type === "function" && !toolChoice.function?.name) {
      console.log(
        `[convertToolChoice] Converting { type: "function" } (no name) to "required"`,
      );
      return "required";
    }

    // { type: "any" } -> "required"
    if (toolChoice.type === "any") {
      console.log(
        `[convertToolChoice] Converting { type: "any" } to "required"`,
      );
      return "required";
    }

    // { type: "none" } -> "none"
    if (toolChoice.type === "none") {
      return "none";
    }

    // { type: "auto" } -> "auto"
    if (toolChoice.type === "auto") {
      return "auto";
    }

    // { type: "required" } -> "required"
    if (toolChoice.type === "required") {
      return "required";
    }

    // 未知对象格式，记录警告并返回 "auto"
    console.warn(
      `[convertToolChoice] Unknown object tool_choice format:`,
      JSON.stringify(toolChoice),
      `defaulting to "auto"`,
    );
    return "auto";
  }

  console.warn(
    `[convertToolChoice] Unexpected tool_choice type:`,
    typeof toolChoice,
    toolChoice,
    `defaulting to "auto"`,
  );
  return "auto";
}

/**
 * 将 OpenAI Chat Completions 格式的 tools 转换为 AI SDK 格式
 * OpenAI: [{ type: "function", function: { name, description, parameters } }]
 * AI SDK: { toolName: tool({ description, inputSchema: jsonSchema({...}) }) }
 */
export function convertOpenAIToolsToAISDK(
  openaiTools: any[],
): Record<string, any> {
  const aiSdkTools: Record<string, any> = {};

  console.log(
    `[convertOpenAIToolsToAISDK] Converting ${openaiTools.length} tools`,
  );

  for (let i = 0; i < openaiTools.length; i++) {
    const t = openaiTools[i];
    try {
      // OpenAI 格式: { type: "function", function: { name, description, parameters } }
      // 或者简化格式: { name, description, parameters }
      const func = t.function || t;
      const name = func.name || t.name;
      const description = func.description || t.description || "";

      if (!name) {
        console.warn(
          `[convertOpenAIToolsToAISDK] Tool at index ${i} has no name, skipping:`,
          JSON.stringify(t).substring(0, 200),
        );
        continue;
      }

      // 确保 parameters 是有效的 JSON Schema
      let parameters = func.parameters || t.parameters;

      // 如果没有 parameters，使用空对象 schema
      if (!parameters) {
        parameters = { type: "object", properties: {} };
      }

      // 确保 parameters 有 type 字段（JSON Schema 要求）
      if (!parameters.type) {
        parameters = { type: "object", ...parameters };
      }

      // 确保 object 类型有 properties 字段
      if (parameters.type === "object" && !parameters.properties) {
        parameters.properties = {};
      }

      aiSdkTools[name] = tool({
        description,
        inputSchema: jsonSchema(parameters),
      });

      console.log(
        `[convertOpenAIToolsToAISDK] Converted tool: ${name}`,
      );
    } catch (error) {
      console.error(
        `[convertOpenAIToolsToAISDK] Failed to convert tool at index ${i}:`,
        error,
        JSON.stringify(t).substring(0, 500),
      );
    }
  }

  console.log(
    `[convertOpenAIToolsToAISDK] Successfully converted ${Object.keys(aiSdkTools).length} tools`,
  );

  return aiSdkTools;
}

/**
 * 将 OpenAI Responses API 的 input 转换为 AI SDK messages 格式
 * 支持处理工具调用和工具调用结果
 * @returns { messages, systemPrompt }
 */
export function convertResponsesInputToAISDK(
  input: string | ResponseInputItem[] | undefined,
  instructions?: string,
): {
  messages: any[];
  system?: string;
} {
  let system = instructions;
  const messages: any[] = [];

  // 用于跟踪待处理的 function_call_output
  const pendingToolResults: Map<string, { output: string; toolName?: string }> =
    new Map();
  // 用于跟踪工具调用信息（从 function_call 类型的输出中获取）
  const toolCallInfo: Map<string, string> = new Map(); // call_id -> toolName

  if (typeof input === "string") {
    // 简单字符串输入
    if (input.trim()) {
      messages.push({ role: "user", content: input });
    }
  } else if (Array.isArray(input)) {
    // 第一遍：收集所有 function_call 信息和 function_call_output
    for (const item of input as any[]) {
      if (item.type === "function_call") {
        // 记录工具调用信息
        toolCallInfo.set(item.call_id || item.id, item.name);
      } else if (item.type === "function_call_output") {
        // 记录工具调用结果
        pendingToolResults.set(item.call_id, {
          output: item.output,
          toolName: toolCallInfo.get(item.call_id),
        });
      }
    }

    // 用于跟踪已处理的 function_call_output
    const processedOutputs: Set<string> = new Set();

    // 第二遍：处理所有输入项
    for (let itemIndex = 0; itemIndex < (input as any[]).length; itemIndex++) {
      const item = (input as any[])[itemIndex];

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
        } else if (item.role === "assistant") {
          // assistant 消息 - 需要检查前面和后面是否有 function_call
          const contentParts: any[] = [];
          let hasToolCalls = false;
          const toolCallIds: string[] = []; // 跟踪这个 assistant 消息中的工具调用 ID

          // 首先查找**之前**的未处理 function_call（在上一个 message 和当前 assistant 之间）
          // 这些 function_call 应该在这个 assistant 消息之前有一个单独的 assistant 消息
          const precedingToolCalls: any[] = [];
          for (let i = itemIndex - 1; i >= 0; i--) {
            const prevItem = (input as any[])[i];
            if (prevItem.type === "message") {
              // 遇到上一个 message 就停止
              break;
            }
            if (prevItem.type === "function_call") {
              const callId = prevItem.call_id || prevItem.id;
              // 检查是否已经被处理
              const alreadyProcessed = messages.some(
                (msg: any) =>
                  msg.role === "assistant" &&
                  Array.isArray(msg.content) &&
                  msg.content.some(
                    (c: any) =>
                      c.type === "tool-call" && c.toolCallId === callId,
                  ),
              );
              if (!alreadyProcessed) {
                precedingToolCalls.unshift(prevItem); // 保持顺序
              }
            }
          }

          // 如果有前置的 function_call，先创建它们的 assistant 消息和 tool 消息
          if (precedingToolCalls.length > 0) {
            const precedingContentParts: any[] = [];
            const precedingToolCallIds: string[] = [];

            for (const fc of precedingToolCalls) {
              const callId = fc.call_id || fc.id;
              precedingToolCallIds.push(callId);
              precedingContentParts.push({
                type: "tool-call",
                toolCallId: callId,
                toolName: fc.name,
                input:
                  typeof fc.arguments === "string"
                    ? JSON.parse(fc.arguments)
                    : fc.arguments,
              });
            }

            messages.push({
              role: "assistant",
              content: precedingContentParts,
            });

            // 收集对应的 function_call_output
            const precedingToolResults: any[] = [];
            for (const callId of precedingToolCallIds) {
              if (!processedOutputs.has(callId)) {
                // 在整个 input 中查找对应的 function_call_output
                const fco = (input as any[]).find(
                  (i: any) =>
                    i.type === "function_call_output" && i.call_id === callId,
                );
                if (fco) {
                  processedOutputs.add(callId);
                  const toolName = toolCallInfo.get(callId) || "unknown";
                  const outputValue =
                    typeof fco.output === "string"
                      ? fco.output
                      : JSON.stringify(fco.output);
                  precedingToolResults.push({
                    type: "tool-result",
                    toolCallId: callId,
                    toolName: toolName,
                    output: {
                      type: "text",
                      value: outputValue,
                    },
                  });
                }
              }
            }

            if (precedingToolResults.length > 0) {
              messages.push({ role: "tool", content: precedingToolResults });
            }
          }

          // 现在处理当前 assistant 消息的内容
          // 注意：Anthropic API 要求 text 内容块必须包含非空白文本
          if (Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === "output_text" && part.text && part.text.trim()) {
                contentParts.push({ type: "text", text: part.text });
              } else if (part.type === "text" && part.text && part.text.trim()) {
                contentParts.push({ type: "text", text: part.text });
              }
            }
          } else if (typeof item.content === "string" && item.content.trim()) {
            contentParts.push({ type: "text", text: item.content });
          }

          // 检查输入中紧随**之后**的 function_call 类型
          // 这些工具调用需要添加到当前 assistant 消息中
          // 关键修复：只收集那些在下一个 message 之前既有 function_call 又有 function_call_output 的调用

          // 首先找到下一个 message 的位置
          let nextMessageIndex = (input as any[]).length;
          for (let i = itemIndex + 1; i < (input as any[]).length; i++) {
            if ((input as any[])[i].type === "message") {
              nextMessageIndex = i;
              break;
            }
          }

          // 收集在 itemIndex+1 到 nextMessageIndex 之间的所有 function_call
          const candidateFunctionCalls: any[] = [];
          for (let i = itemIndex + 1; i < nextMessageIndex; i++) {
            const nextItem = (input as any[])[i];
            if (nextItem.type === "function_call") {
              candidateFunctionCalls.push(nextItem);
            }
          }

          // 收集在 itemIndex+1 到 nextMessageIndex 之间的所有 function_call_output 的 call_id
          const availableOutputIds = new Set<string>();
          for (let i = itemIndex + 1; i < nextMessageIndex; i++) {
            const nextItem = (input as any[])[i];
            if (nextItem.type === "function_call_output") {
              availableOutputIds.add(nextItem.call_id);
            }
          }

          // 只添加那些在同一区间内有对应 output 的 function_call
          for (const fc of candidateFunctionCalls) {
            const callId = fc.call_id || fc.id;
            if (availableOutputIds.has(callId)) {
              hasToolCalls = true;
              toolCallIds.push(callId);
              // AI SDK 6.x 使用 'input' 而不是 'args'
              contentParts.push({
                type: "tool-call",
                toolCallId: callId,
                toolName: fc.name,
                input:
                  typeof fc.arguments === "string"
                    ? JSON.parse(fc.arguments)
                    : fc.arguments,
              });
            }
            // 如果 function_call 没有对应的 output 在同一区间内，
            // 它会在后续的 function_call 处理分支中被单独处理
          }

          if (contentParts.length > 0 || hasToolCalls) {
            messages.push({ role: "assistant", content: contentParts });
          }

          // 如果有工具调用，收集对应的 function_call_output 并合并到一个 tool 消息中
          if (toolCallIds.length > 0) {
            const toolResults: any[] = [];

            // 只在同一区间内查找 function_call_output
            for (let i = itemIndex + 1; i < nextMessageIndex; i++) {
              const nextItem = (input as any[])[i];
              if (
                nextItem.type === "function_call_output" &&
                toolCallIds.includes(nextItem.call_id)
              ) {
                if (!processedOutputs.has(nextItem.call_id)) {
                  processedOutputs.add(nextItem.call_id);
                  const toolName =
                    toolCallInfo.get(nextItem.call_id) || "unknown";
                  const outputValue =
                    typeof nextItem.output === "string"
                      ? nextItem.output
                      : JSON.stringify(nextItem.output);

                  toolResults.push({
                    type: "tool-result",
                    toolCallId: nextItem.call_id,
                    toolName: toolName,
                    output: {
                      type: "text",
                      value: outputValue,
                    },
                  });
                }
              }
            }

            // 将所有工具结果合并到一个 tool 消息中
            if (toolResults.length > 0) {
              messages.push({
                role: "tool",
                content: toolResults,
              });
            }
          }
        } else {
          // user 消息
          let content: any;
          if (typeof item.content === "string") {
            content = item.content;
          } else if (Array.isArray(item.content)) {
            // 转换 content parts，过滤空内容
            // 注意：Anthropic API 要求 text 内容块必须包含非空白文本
            const parts: Array<{
              type: string;
              text?: string;
              image?: string;
            }> = [];
            for (const part of item.content as any[]) {
              if (part.type === "input_text" && part.text && part.text.trim()) {
                parts.push({ type: "text", text: part.text });
              } else if (part.type === "input_image" && part.image_url) {
                parts.push({ type: "image", image: part.image_url });
              } else if (part.type === "text" && part.text && part.text.trim()) {
                parts.push({ type: "text", text: part.text });
              } else if (part.type === "output_text" && part.text && part.text.trim()) {
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
      // 注意：大部分 function_call_output 已经在 assistant 消息处理中被合并了
      // 这里只处理没有对应 assistant 消息的孤立 function_call_output
      else if (item.type === "function_call_output") {
        if (!processedOutputs.has(item.call_id)) {
          processedOutputs.add(item.call_id);

          const toolName = toolCallInfo.get(item.call_id) || "unknown";
          const outputValue =
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output);

          // 检查前一条消息是否是 tool 消息，如果是则合并
          const lastMessage = messages[messages.length - 1];
          if (lastMessage && lastMessage.role === "tool") {
            // 检查前面是否有对应的 assistant 消息包含这个 tool-call
            // 如果没有，需要先添加 assistant 消息
            const secondLastMessage = messages[messages.length - 2];
            const hasCorrespondingToolCall =
              secondLastMessage &&
              secondLastMessage.role === "assistant" &&
              Array.isArray(secondLastMessage.content) &&
              secondLastMessage.content.some(
                (c: any) =>
                  c.type === "tool-call" && c.toolCallId === item.call_id,
              );

            if (hasCorrespondingToolCall) {
              // 合并到前一个 tool 消息中
              lastMessage.content.push({
                type: "tool-result",
                toolCallId: item.call_id,
                toolName: toolName,
                output: {
                  type: "text",
                  value: outputValue,
                },
              });
            } else {
              // 需要找到对应的 function_call 并创建 assistant 消息
              const functionCall = (input as any[]).find(
                (i: any) =>
                  i.type === "function_call" &&
                  (i.call_id === item.call_id || i.id === item.call_id),
              );

              if (functionCall) {
                // 在 tool 消息前插入 assistant 消息
                const assistantContent = [
                  {
                    type: "tool-call",
                    toolCallId: item.call_id,
                    toolName: functionCall.name,
                    input:
                      typeof functionCall.arguments === "string"
                        ? JSON.parse(functionCall.arguments)
                        : functionCall.arguments,
                  },
                ];

                // 插入 assistant 消息在 tool 消息之前
                messages.splice(messages.length - 1, 0, {
                  role: "assistant",
                  content: assistantContent,
                });

                // 合并到 tool 消息中
                lastMessage.content.push({
                  type: "tool-result",
                  toolCallId: item.call_id,
                  toolName: toolName,
                  output: {
                    type: "text",
                    value: outputValue,
                  },
                });
              } else {
                // 没有对应的 function_call，跳过这个 output
                console.log(
                  `[convertResponsesInputToAISDK] Skipping orphan function_call_output with call_id: ${item.call_id}`,
                );
              }
            }
          } else {
            // 前一条消息不是 tool 消息
            // 首先检查是否已经有包含对应 tool-call 的 assistant 消息
            const existingAssistantIndex = messages.findIndex(
              (msg: any) =>
                msg.role === "assistant" &&
                Array.isArray(msg.content) &&
                msg.content.some(
                  (c: any) =>
                    c.type === "tool-call" && c.toolCallId === item.call_id,
                ),
            );

            if (existingAssistantIndex !== -1) {
              // 已经有对应的 assistant 消息，只需要在它后面添加 tool 消息
              // 检查 assistant 消息后面是否已有 tool 消息
              const nextMessage = messages[existingAssistantIndex + 1];
              if (nextMessage && nextMessage.role === "tool") {
                // 合并到现有的 tool 消息中
                nextMessage.content.push({
                  type: "tool-result",
                  toolCallId: item.call_id,
                  toolName: toolName,
                  output: {
                    type: "text",
                    value: outputValue,
                  },
                });
              } else {
                // 在 assistant 消息后插入新的 tool 消息
                messages.splice(existingAssistantIndex + 1, 0, {
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: item.call_id,
                      toolName: toolName,
                      output: {
                        type: "text",
                        value: outputValue,
                      },
                    },
                  ],
                });
              }
            } else {
              // 没有对应的 assistant 消息，需要创建
              const functionCall = (input as any[]).find(
                (i: any) =>
                  i.type === "function_call" &&
                  (i.call_id === item.call_id || i.id === item.call_id),
              );

              if (functionCall) {
                // 创建 assistant 消息包含 tool-call
                messages.push({
                  role: "assistant",
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: item.call_id,
                      toolName: functionCall.name,
                      input:
                        typeof functionCall.arguments === "string"
                          ? JSON.parse(functionCall.arguments)
                          : functionCall.arguments,
                    },
                  ],
                });

                // 创建 tool 消息包含 tool-result
                messages.push({
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: item.call_id,
                      toolName: toolName,
                      output: {
                        type: "text",
                        value: outputValue,
                      },
                    },
                  ],
                });
              } else {
                // 没有对应的 function_call，跳过这个 output
                console.log(
                  `[convertResponsesInputToAISDK] Skipping orphan function_call_output with call_id: ${item.call_id}`,
                );
              }
            }
          }
        }
      }
      // function_call 类型 - 检查是否已被 assistant 消息处理
      else if (item.type === "function_call") {
        const callId = item.call_id || item.id;

        // 检查是否已经有 assistant 消息包含这个 tool-call
        const alreadyProcessed = messages.some(
          (msg: any) =>
            msg.role === "assistant" &&
            Array.isArray(msg.content) &&
            msg.content.some(
              (c: any) => c.type === "tool-call" && c.toolCallId === callId,
            ),
        );

        if (!alreadyProcessed) {
          // 收集从当前位置开始的所有连续 function_call（未被处理的）
          const batchCallIds: string[] = [];
          const batchCalls: any[] = [];

          for (let j = itemIndex; j < (input as any[]).length; j++) {
            const futureItem = (input as any[])[j];
            if (futureItem.type === "function_call") {
              const fCallId = futureItem.call_id || futureItem.id;
              // 检查是否已处理
              const fAlreadyProcessed = messages.some(
                (msg: any) =>
                  msg.role === "assistant" &&
                  Array.isArray(msg.content) &&
                  msg.content.some(
                    (c: any) =>
                      c.type === "tool-call" && c.toolCallId === fCallId,
                  ),
              );
              if (!fAlreadyProcessed) {
                batchCallIds.push(fCallId);
                batchCalls.push(futureItem);
              }
            } else if (
              futureItem.type === "message" ||
              futureItem.type === "function_call_output"
            ) {
              // 遇到 message 或 function_call_output 就停止收集
              break;
            }
          }

          if (batchCalls.length > 0) {
            // 创建包含所有 tool-call 的 assistant 消息
            const toolCallContents = batchCalls.map((fc) => ({
              type: "tool-call",
              toolCallId: fc.call_id || fc.id,
              toolName: fc.name,
              input:
                typeof fc.arguments === "string"
                  ? JSON.parse(fc.arguments)
                  : fc.arguments,
            }));

            // 检查前一条消息是否是 assistant 消息，如果是则合并
            const lastMessage = messages[messages.length - 1];
            if (
              lastMessage &&
              lastMessage.role === "assistant" &&
              Array.isArray(lastMessage.content)
            ) {
              // 添加到现有的 assistant 消息中
              lastMessage.content.push(...toolCallContents);
            } else {
              // 创建新的 assistant 消息
              messages.push({
                role: "assistant",
                content: toolCallContents,
              });
            }

            // 收集所有对应的 function_call_output
            const toolResults: any[] = [];
            for (const fCallId of batchCallIds) {
              if (!processedOutputs.has(fCallId)) {
                const fco = (input as any[]).find(
                  (i: any) =>
                    i.type === "function_call_output" && i.call_id === fCallId,
                );
                if (fco) {
                  processedOutputs.add(fCallId);
                  const toolName = toolCallInfo.get(fCallId) || "unknown";
                  const outputValue =
                    typeof fco.output === "string"
                      ? fco.output
                      : JSON.stringify(fco.output);

                  toolResults.push({
                    type: "tool-result",
                    toolCallId: fCallId,
                    toolName: toolName,
                    output: {
                      type: "text",
                      value: outputValue,
                    },
                  });
                }
              }
            }

            // 创建包含所有 tool-result 的 tool 消息
            if (toolResults.length > 0) {
              messages.push({
                role: "tool",
                content: toolResults,
              });
            }
          }
        }
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

  // 后处理：合并连续的 user 消息，确保消息格式符合 Anthropic API 要求
  const processedMessages = postProcessMessages(messages);

  return { messages: processedMessages, system };
}

/**
 * 后处理消息：
 * 1. 合并连续的 user 消息
 * 2. 确保 tool-call 后面紧跟 tool-result
 */
function postProcessMessages(messages: any[]): any[] {
  const result: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const lastMsg = result[result.length - 1];

    // 合并连续的 user 消息
    if (msg.role === "user" && lastMsg && lastMsg.role === "user") {
      // 确保 content 是数组格式
      if (!Array.isArray(lastMsg.content)) {
        lastMsg.content = [{ type: "text", text: lastMsg.content }];
      }
      if (Array.isArray(msg.content)) {
        lastMsg.content.push(...msg.content);
      } else {
        lastMsg.content.push({ type: "text", text: msg.content });
      }
    } else {
      result.push(JSON.parse(JSON.stringify(msg)));
    }
  }

  // 验证并修复 tool-call/tool-result 顺序
  // 确保每个包含 tool-call 的 assistant 消息后面紧跟包含对应 tool-result 的 tool 消息
  const validated: any[] = [];
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    validated.push(msg);

    // 检查是否是包含 tool-call 的 assistant 消息
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some((c: any) => c.type === "tool-call")
    ) {
      const toolCallIds = msg.content
        .filter((c: any) => c.type === "tool-call")
        .map((c: any) => c.toolCallId);

      // 检查下一条消息是否是 tool 消息且包含所有对应的 tool-result
      const nextMsg = result[i + 1];
      if (nextMsg && nextMsg.role === "tool") {
        // 下一条是 tool 消息，检查是否包含所有需要的 tool-result
        const toolResultIds = new Set(
          nextMsg.content
            .filter((c: any) => c.type === "tool-result")
            .map((c: any) => c.toolCallId),
        );

        const missingToolCallIds = toolCallIds.filter(
          (id: string) => !toolResultIds.has(id),
        );

        if (missingToolCallIds.length > 0) {
          console.log(
            `[postProcessMessages] Warning: tool-call ids ${missingToolCallIds.join(", ")} have no tool-result in next message`,
          );
        }
      } else {
        // 下一条不是 tool 消息，需要找到对应的 tool-result 并插入
        // 查找后续消息中的 tool-result
        const toolResults: any[] = [];
        for (let j = i + 1; j < result.length; j++) {
          const futureMsg = result[j];
          if (futureMsg.role === "tool" && Array.isArray(futureMsg.content)) {
            for (const c of futureMsg.content) {
              if (
                c.type === "tool-result" &&
                toolCallIds.includes(c.toolCallId)
              ) {
                toolResults.push(c);
              }
            }
          }
        }

        if (toolResults.length > 0) {
          // 插入一个 tool 消息
          validated.push({
            role: "tool",
            content: toolResults,
          });

          // 标记这些 tool-result 已经被使用，需要从原来的位置移除
          // 通过在后续处理中跳过已使用的 tool-result
          for (let j = i + 1; j < result.length; j++) {
            const futureMsg = result[j];
            if (futureMsg.role === "tool" && Array.isArray(futureMsg.content)) {
              futureMsg.content = futureMsg.content.filter(
                (c: any) =>
                  c.type !== "tool-result" ||
                  !toolCallIds.includes(c.toolCallId),
              );
            }
          }
        }
      }
    }
  }

  // 移除空的 tool 消息
  return validated.filter(
    (msg) =>
      msg.role !== "tool" ||
      (Array.isArray(msg.content) && msg.content.length > 0),
  );
}
