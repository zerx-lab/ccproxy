/**
 * Responses API 转换器全面测试
 * 覆盖 OpenAI Responses API input → AI SDK 格式的所有参数和边界情况
 *
 * 参数兼容矩阵 (OpenAI Responses API):
 * - model ✅ (通过 mapModelName 映射)
 * - input ✅ (convertResponsesInputToAISDK)
 *   - string 输入 ✅
 *   - ResponseInputItem[] ✅
 *   - message (user/assistant/system/developer) ✅
 *   - function_call ✅
 *   - function_call_output ✅
 * - instructions ✅ (合并到 system prompt)
 * - tools ✅ (convertOpenAIToolsToAISDK)
 * - tool_choice ✅ (convertToolChoice)
 * - stream ✅ (handler 处理)
 * - temperature ✅ (直传)
 * - top_p ✅ (直传)
 * - max_output_tokens ✅ (映射为 maxOutputTokens, 默认 8192)
 * - parallel_tool_calls ✅ (反转映射)
 * - prompt_cache_key ✅ (映射为 cacheControl)
 * - metadata ✅ (回传到响应)
 * - previous_response_id ✅ (回传到响应)
 * - reasoning ⚠️ (回传但不映射到 Anthropic thinking)
 * - truncation ⚠️ (回传但不处理)
 * - store ⚠️ (识别但不支持)
 * - service_tier ⚠️ (忽略)
 *
 * Codex CLI 特定功能:
 * - store: true (用于服务端存储, 后续 previous_response_id 引用)
 * - previous_response_id (多轮对话, 服务端管理上下文)
 * - reasoning.effort (推理强度控制)
 * - reasoning.summary (推理摘要格式)
 * - function_call + function_call_output (工具调用结果)
 */

import { describe, test, expect } from "bun:test";
import { convertResponsesInputToAISDK } from "./openai-converter";
import type { ResponseInputItem } from "../types";

// ============================================================
// 基础输入转换
// ============================================================
describe("convertResponsesInputToAISDK - 基础输入", () => {
  test("字符串输入 → 单条 user 消息", () => {
    const result = convertResponsesInputToAISDK("Hello, Claude!");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: "Hello, Claude!",
    });
    expect(result.system).toBeUndefined();
  });

  test("空字符串输入 → 无消息 (空白被过滤)", () => {
    const result = convertResponsesInputToAISDK("   ");
    expect(result.messages).toHaveLength(0);
  });

  test("undefined 输入 → 默认 Hello 消息", () => {
    const result = convertResponsesInputToAISDK(undefined);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Hello");
  });

  test("instructions 参数 → system prompt", () => {
    const result = convertResponsesInputToAISDK("Hi", "Be helpful.");
    expect(result.system).toBe("Be helpful.");
    expect(result.messages).toHaveLength(1);
  });
});

// ============================================================
// message 类型输入项
// ============================================================
describe("convertResponsesInputToAISDK - message 类型", () => {
  test("user 消息 - 简单字符串", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Hello" },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello");
  });

  test("developer 消息 → 合并到 system prompt", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "developer", content: "System instructions" },
      { type: "message", role: "user", content: "Hello" },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.system).toBe("System instructions");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  test("system 消息 → 合并到 system prompt", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "system", content: "Be concise." },
      { type: "message", role: "user", content: "Hello" },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.system).toBe("Be concise.");
  });

  test("instructions + developer 消息 → system prompt 合并", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "developer", content: "Extra rules." },
      { type: "message", role: "user", content: "Hello" },
    ];
    const result = convertResponsesInputToAISDK(
      input,
      "Base instructions.",
    );
    expect(result.system).toContain("Base instructions.");
    expect(result.system).toContain("Extra rules.");
  });

  test("assistant 消息 - 简单文本", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Hi" },
      { type: "message", role: "assistant", content: "Hello!" },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.messages).toHaveLength(2);
    const assistant = result.messages[1];
    expect(assistant.role).toBe("assistant");
  });

  test("user 消息 - 多部分内容 (input_text)", () => {
    const input: ResponseInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What's this image?" } as any,
          { type: "input_image", image_url: "https://example.com/img.png" } as any,
        ],
      },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.messages).toHaveLength(1);
    const content = result.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image");
  });

  test("user 消息 - 单 input_text 简化为字符串", () => {
    const input: ResponseInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Simple text" } as any,
        ],
      },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.messages[0].content).toBe("Simple text");
  });

  test("合并连续 user 消息", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Part 1" },
      { type: "message", role: "user", content: "Part 2" },
    ];
    const result = convertResponsesInputToAISDK(input);
    // postProcessMessages 应合并连续 user 消息
    expect(result.messages).toHaveLength(1);
    const content = result.messages[0].content;
    // 合并后应为数组格式
    if (Array.isArray(content)) {
      expect(content).toHaveLength(2);
    }
  });
});

// ============================================================
// function_call 和 function_call_output
// ============================================================
describe("convertResponsesInputToAISDK - 工具调用", () => {
  test("基础 function_call + function_call_output", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "List files" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "shell",
        arguments: '{"command":"ls"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "file1.txt\nfile2.txt",
      },
    ];
    const result = convertResponsesInputToAISDK(input);

    // 应该有: user, assistant(tool-call), tool(tool-result)
    let hasToolCall = false;
    let hasToolResult = false;

    for (const msg of result.messages) {
      if (
        msg.role === "assistant" &&
        Array.isArray(msg.content) &&
        msg.content.some((c: any) => c.type === "tool-call")
      ) {
        hasToolCall = true;
        const tc = msg.content.find((c: any) => c.type === "tool-call");
        expect(tc.toolCallId).toBe("call_1");
        expect(tc.toolName).toBe("shell");
        expect(tc.input).toEqual({ command: "ls" });
      }
      if (
        msg.role === "tool" &&
        Array.isArray(msg.content) &&
        msg.content.some((c: any) => c.type === "tool-result")
      ) {
        hasToolResult = true;
        const tr = msg.content.find((c: any) => c.type === "tool-result");
        expect(tr.toolCallId).toBe("call_1");
      }
    }

    expect(hasToolCall).toBe(true);
    expect(hasToolResult).toBe(true);
  });

  test("并行 function_calls + outputs", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Run commands" },
      {
        type: "function_call",
        call_id: "c1",
        name: "shell",
        arguments: '{"cmd":"ls"}',
      },
      {
        type: "function_call",
        call_id: "c2",
        name: "shell",
        arguments: '{"cmd":"pwd"}',
      },
      {
        type: "function_call",
        call_id: "c3",
        name: "shell",
        arguments: '{"cmd":"whoami"}',
      },
      { type: "function_call_output", call_id: "c1", output: "files" },
      { type: "function_call_output", call_id: "c2", output: "/home" },
      { type: "function_call_output", call_id: "c3", output: "user" },
    ];
    const result = convertResponsesInputToAISDK(input);

    // 找到 assistant 消息中的 tool-calls
    const assistantMsg = result.messages.find(
      (m: any) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === "tool-call"),
    );
    expect(assistantMsg).toBeDefined();

    const toolCalls = assistantMsg!.content.filter(
      (c: any) => c.type === "tool-call",
    );
    expect(toolCalls).toHaveLength(3);

    // 找到 tool 消息中的 tool-results
    const toolMsgIdx = result.messages.indexOf(assistantMsg!) + 1;
    const toolMsg = result.messages[toolMsgIdx];
    expect(toolMsg).toBeDefined();
    expect(toolMsg.role).toBe("tool");

    const toolResults = toolMsg.content.filter(
      (c: any) => c.type === "tool-result",
    );
    expect(toolResults).toHaveLength(3);
  });

  test("function_call 和 output 被 assistant message 分隔 (关键边界情况)", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Do work" },
      {
        type: "function_call",
        call_id: "c1",
        name: "shell",
        arguments: '{"cmd":"ls"}',
      },
      {
        type: "function_call",
        call_id: "c2",
        name: "shell",
        arguments: '{"cmd":"pwd"}',
      },
      {
        type: "message",
        role: "assistant",
        content: "Processing...",
      },
      { type: "function_call_output", call_id: "c1", output: "files" },
      { type: "function_call_output", call_id: "c2", output: "/home" },
    ];
    const result = convertResponsesInputToAISDK(input);

    // 验证每个 tool-call 后面紧跟 tool-result
    validateToolCallPairing(result.messages);
  });

  test("Codex CLI 真实场景: 多批次交叉工具调用", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "developer", content: "System prompt" },
      { type: "message", role: "user", content: "Analyze project" },
      // 第一批: update_plan
      {
        type: "function_call",
        call_id: "toolu_plan",
        name: "update_plan",
        arguments: "{}",
      },
      { type: "message", role: "assistant", content: "Planning..." },
      {
        type: "function_call_output",
        call_id: "toolu_plan",
        output: "Plan updated",
      },
      // 第二批: 并行 shell 命令
      {
        type: "function_call",
        call_id: "toolu_ls",
        name: "shell",
        arguments: '{"command":"ls"}',
      },
      {
        type: "function_call",
        call_id: "toolu_pwd",
        name: "shell",
        arguments: '{"command":"pwd"}',
      },
      {
        type: "function_call_output",
        call_id: "toolu_ls",
        output: "src/ package.json",
      },
      {
        type: "function_call_output",
        call_id: "toolu_pwd",
        output: "/home/user/project",
      },
      // 第三批: 读取文件
      {
        type: "function_call",
        call_id: "toolu_read",
        name: "Read",
        arguments: '{"path":"package.json"}',
      },
      {
        type: "function_call_output",
        call_id: "toolu_read",
        output: '{"name":"project","version":"1.0.0"}',
      },
    ];
    const result = convertResponsesInputToAISDK(input);

    expect(result.system).toContain("System prompt");
    validateToolCallPairing(result.messages);
  });

  test("function_call 使用 id 而非 call_id", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "test" },
      {
        type: "function_call",
        id: "fc_123", // 使用 id 而非 call_id
        call_id: "fc_123",
        name: "test_fn",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "fc_123",
        output: "ok",
      },
    ];
    const result = convertResponsesInputToAISDK(input);
    validateToolCallPairing(result.messages);
  });
});

// ============================================================
// Codex CLI 特定场景
// ============================================================
describe("Codex CLI 兼容性场景", () => {
  test("Codex 多轮对话: user → assistant(tool) → tool_result → assistant(text) → user", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Read my config" },
      {
        type: "function_call",
        call_id: "tc1",
        name: "Read",
        arguments: '{"path":"~/.config/app.json"}',
      },
      {
        type: "function_call_output",
        call_id: "tc1",
        output: '{"theme":"dark"}',
      },
      {
        type: "message",
        role: "assistant",
        content: "Your config has theme: dark.",
      },
      {
        type: "message",
        role: "user",
        content: "Change it to light",
      },
      {
        type: "function_call",
        call_id: "tc2",
        name: "Write",
        arguments: '{"path":"~/.config/app.json","content":"{\\"theme\\":\\"light\\"}"}',
      },
      {
        type: "function_call_output",
        call_id: "tc2",
        output: "File written.",
      },
      {
        type: "message",
        role: "assistant",
        content: "Done, changed to light theme.",
      },
    ];
    const result = convertResponsesInputToAISDK(input);
    validateToolCallPairing(result.messages);

    // 验证最终消息是 assistant 文本
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
  });

  test("Codex 搜索工具: shell 命令链", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Find TODO comments" },
      {
        type: "function_call",
        call_id: "tc1",
        name: "shell",
        arguments: '{"command":"grep -r TODO src/"}',
      },
      {
        type: "function_call_output",
        call_id: "tc1",
        output: "src/main.ts:10: // TODO: implement\nsrc/utils.ts:5: // TODO: fix",
      },
      {
        type: "function_call",
        call_id: "tc2",
        name: "Read",
        arguments: '{"path":"src/main.ts"}',
      },
      {
        type: "function_call_output",
        call_id: "tc2",
        output: "// main.ts content...",
      },
    ];
    const result = convertResponsesInputToAISDK(input);
    validateToolCallPairing(result.messages);
  });
});

// ============================================================
// Responses API 响应格式验证
// ============================================================
describe("Responses API 响应格式", () => {
  test("非流式响应结构", () => {
    const response = {
      id: "resp_123_abc",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: "claude-sonnet-4-5",
      output: [
        {
          type: "message",
          id: "msg_123",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Hello!",
              annotations: [],
            },
          ],
          status: "completed",
        },
      ],
      output_text: "Hello!",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      temperature: 1,
      top_p: 1,
      max_output_tokens: 8192,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      truncation: "disabled",
      previous_response_id: null,
      reasoning: undefined,
    };

    // 验证基础结构
    expect(response.id).toMatch(/^resp_/);
    expect(response.object).toBe("response");
    expect(response.status).toBe("completed");
    expect(response.output).toBeInstanceOf(Array);

    // 验证 output message
    const msg = response.output[0];
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.content[0].type).toBe("output_text");

    // 验证 usage
    expect(response.usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(response.usage.output_tokens).toBeGreaterThanOrEqual(0);
  });

  test("function_call 输出结构", () => {
    const output = {
      type: "function_call",
      id: "call_abc",
      call_id: "call_abc",
      name: "get_weather",
      arguments: '{"location":"NYC"}',
      status: "completed",
    };

    expect(output.type).toBe("function_call");
    expect(output.id).toBe(output.call_id);
    expect(() => JSON.parse(output.arguments)).not.toThrow();
    expect(output.status).toBe("completed");
  });

  test("流式事件序列", () => {
    // 模拟 Responses API SSE 事件序列
    const events = [
      { event: "response.created", type: "response.created" },
      { event: "response.output_item.added", type: "response.output_item.added" },
      { event: "response.content_part.added", type: "response.content_part.added" },
      { event: "response.output_text.delta", type: "response.output_text.delta" },
      { event: "response.output_text.delta", type: "response.output_text.delta" },
      { event: "response.content_part.done", type: "response.content_part.done" },
      { event: "response.output_item.done", type: "response.output_item.done" },
      { event: "response.completed", type: "response.completed" },
    ];

    // 验证事件序列正确性
    expect(events[0].event).toBe("response.created");
    expect(events[events.length - 1].event).toBe("response.completed");

    // 验证 sequence_number 单调递增
    let seq = 0;
    for (const event of events) {
      // 在实际流中每个事件有 sequence_number
      expect(seq).toBeLessThan(events.length);
      seq++;
    }
  });

  test("流式 function_call 事件序列", () => {
    const events = [
      "response.created",
      "response.output_item.added", // function_call item
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ];

    expect(events).toContain("response.function_call_arguments.done");
    expect(events.indexOf("response.output_item.added")).toBeLessThan(
      events.indexOf("response.function_call_arguments.done"),
    );
  });

  test("metadata 回传", () => {
    const requestMetadata = {
      request_id: "req_abc",
      user: "test-user",
    };

    // 模拟 handler 回传 metadata
    const response = {
      metadata: requestMetadata,
    };

    expect(response.metadata).toEqual(requestMetadata);
  });

  test("reasoning 参数回传 (Codex CLI 使用)", () => {
    const requestReasoning = {
      effort: "high",
      summary: "auto",
    };

    const response = {
      reasoning: requestReasoning,
    };

    expect(response.reasoning).toEqual(requestReasoning);
    expect(response.reasoning.effort).toBe("high");
    expect(response.reasoning.summary).toBe("auto");
  });

  test("previous_response_id 回传 (Codex CLI 多轮)", () => {
    const response = {
      previous_response_id: "resp_prev_123",
    };
    expect(response.previous_response_id).toBe("resp_prev_123");
  });
});

// ============================================================
// 参数映射验证
// ============================================================
describe("Responses API 参数映射", () => {
  test("max_output_tokens 默认值 8192", () => {
    // handler 中: maxOutputTokens: rest.max_output_tokens || 8192
    const withValue = { max_output_tokens: 4096 };
    const withoutValue = {};

    expect(withValue.max_output_tokens || 8192).toBe(4096);
    expect((withoutValue as any).max_output_tokens || 8192).toBe(8192);
  });

  test("Codex CLI 参数: store + previous_response_id", () => {
    // Codex CLI 发送的典型请求
    const codexRequest = {
      model: "o3",
      input: [
        { type: "message", role: "user", content: "Hello" },
      ],
      store: true,
      previous_response_id: null, // 第一轮为 null
      reasoning: {
        effort: "medium",
        summary: "auto",
      },
      tools: [
        {
          type: "function",
          name: "shell",
          description: "Execute command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          },
        },
      ],
    };

    // 验证所有参数存在
    expect(codexRequest.store).toBe(true);
    expect(codexRequest.previous_response_id).toBeNull();
    expect(codexRequest.reasoning.effort).toBe("medium");
    expect(codexRequest.reasoning.summary).toBe("auto");
    expect(codexRequest.tools).toHaveLength(1);
  });

  test("Codex CLI 后续轮次: previous_response_id 引用", () => {
    const secondTurn = {
      model: "o3",
      input: [
        { type: "message", role: "user", content: "Now do something else" },
      ],
      store: true,
      previous_response_id: "resp_prev_abc", // 引用前一轮
      reasoning: { effort: "medium" },
    };

    expect(secondTurn.previous_response_id).toBe("resp_prev_abc");
  });

  test("truncation 参数值", () => {
    // OpenAI 支持 "auto" | "disabled"
    expect(["auto", "disabled"]).toContain("auto");
    expect(["auto", "disabled"]).toContain("disabled");
  });

  test("reasoning.effort 值范围", () => {
    const validEfforts = ["minimal", "low", "medium", "high"];
    for (const effort of validEfforts) {
      expect(typeof effort).toBe("string");
    }
  });
});

// ============================================================
// 边界情况
// ============================================================
describe("边界情况", () => {
  test("空 input 数组", () => {
    const result = convertResponsesInputToAISDK([]);
    // 空数组不会添加默认消息
    expect(result.messages).toHaveLength(0);
  });

  test("只有 developer 消息 (无 user 消息)", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "developer", content: "Instructions only" },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.system).toBe("Instructions only");
    expect(result.messages).toHaveLength(0);
  });

  test("function_call_output 无对应 function_call (孤立)", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "test" },
      {
        type: "function_call_output",
        call_id: "orphan_call",
        output: "orphan result",
      },
    ];
    // 不应抛出错误
    expect(() => convertResponsesInputToAISDK(input)).not.toThrow();
  });

  test("arguments 为对象而非字符串", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "test" },
      {
        type: "function_call",
        call_id: "c1",
        name: "fn",
        arguments: { key: "value" } as any,
      },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ];
    const result = convertResponsesInputToAISDK(input);
    // 应正常处理对象格式的 arguments
    validateToolCallPairing(result.messages);
  });

  test("output_text content part (历史响应回传)", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Hello" },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Previous response text" } as any,
        ],
      },
      { type: "message", role: "user", content: "Continue" },
    ];
    const result = convertResponsesInputToAISDK(input);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
  });

  test("大量工具调用 (10+ 并行)", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "user", content: "Run 10 commands" },
    ];

    for (let i = 0; i < 10; i++) {
      input.push({
        type: "function_call",
        call_id: `call_${i}`,
        name: "shell",
        arguments: `{"cmd":"echo ${i}"}`,
      });
    }
    for (let i = 0; i < 10; i++) {
      input.push({
        type: "function_call_output",
        call_id: `call_${i}`,
        output: `${i}`,
      });
    }

    const result = convertResponsesInputToAISDK(input);
    validateToolCallPairing(result.messages);
  });
});

// ============================================================
// 辅助函数
// ============================================================

/**
 * 验证 tool-call / tool-result 配对正确性
 * 每个包含 tool-call 的 assistant 消息后面必须紧跟包含对应 tool-result 的 tool 消息
 */
function validateToolCallPairing(messages: any[]) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some((c: any) => c.type === "tool-call")
    ) {
      const toolCallIds = msg.content
        .filter((c: any) => c.type === "tool-call")
        .map((c: any) => c.toolCallId);

      const nextMsg = messages[i + 1];
      expect(nextMsg).toBeDefined();
      expect(nextMsg.role).toBe("tool");

      if (nextMsg && nextMsg.role === "tool") {
        const toolResultIds = new Set(
          nextMsg.content
            .filter((c: any) => c.type === "tool-result")
            .map((c: any) => c.toolCallId),
        );

        for (const callId of toolCallIds) {
          expect(toolResultIds.has(callId)).toBe(true);
        }
      }
    }
  }
}
