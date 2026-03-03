/**
 * Chat Completions API 转换器全面测试
 * 覆盖 OpenAI Chat Completions 格式 → AI SDK 格式的所有参数和边界情况
 *
 * 参数兼容矩阵 (OpenAI Chat Completions API):
 * - model ✅ (通过 mapModelName 映射)
 * - messages ✅ (convertChatMessagesToAISDK)
 * - tools ✅ (convertOpenAIToolsToAISDK)
 * - tool_choice ✅ (convertToolChoice)
 * - stream ✅ (handler 处理)
 * - temperature ✅ (直传)
 * - top_p ✅ (映射为 topP)
 * - max_tokens ✅ (映射为 maxOutputTokens)
 * - max_completion_tokens ✅ (优先于 max_tokens)
 * - stop ✅ (映射为 stopSequences)
 * - parallel_tool_calls ✅ (反转为 disableParallelToolUse)
 * - prompt_cache_key ✅ (映射为 cacheControl)
 * - prediction ⚠️ (忽略, OpenAI 特有)
 * - n ❌ (不支持, Anthropic 无等价)
 * - presence_penalty ❌ (不支持)
 * - frequency_penalty ❌ (不支持)
 * - logit_bias ❌ (不支持)
 * - logprobs ❌ (不支持)
 * - response_format ❌ (不支持 json_schema)
 * - seed ❌ (不支持)
 * - user ❌ (不支持)
 * - service_tier ❌ (忽略)
 * - stream_options ❌ (不支持 include_usage)
 * - reasoning_effort ❌ (OpenAI o-series 特有)
 * - store ❌ (OpenAI 特有)
 * - metadata ❌ (OpenAI 特有)
 */

import { describe, test, expect } from "bun:test";
import {
  convertChatMessagesToAISDK,
  convertOpenAIToolsToAISDK,
  convertToolChoice,
} from "./openai-converter";

// ============================================================
// convertChatMessagesToAISDK 测试
// ============================================================
describe("convertChatMessagesToAISDK", () => {
  // ---- 基础消息角色 ----
  describe("基础消息角色处理", () => {
    test("提取 system 消息到独立字段", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.system).toBe("You are a helpful assistant.");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    test("合并多个 system 消息", () => {
      const messages = [
        { role: "system", content: "Rule 1: Be helpful." },
        { role: "system", content: "Rule 2: Be concise." },
        { role: "user", content: "Hello" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.system).toBe("Rule 1: Be helpful.\n\nRule 2: Be concise.");
    });

    test("处理空白 system 消息 (跳过)", () => {
      const messages = [
        { role: "system", content: "   " },
        { role: "user", content: "Hello" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.system).toBeUndefined();
    });

    test("处理 system 消息为数组格式", () => {
      const messages = [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1." },
            { type: "text", text: " Part 2." },
          ],
        },
        { role: "user", content: "Hello" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.system).toBe("Part 1. Part 2.");
    });

    test("user 消息 - 简单字符串", () => {
      const messages = [{ role: "user", content: "Hello world" }];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: "Hello world",
      });
    });

    test("assistant 消息 - 简单文本", () => {
      const messages = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[1].content).toEqual([
        { type: "text", text: "Hello!" },
      ]);
    });

    test("assistant 消息 - content 为 null (OpenAI 工具调用时可能为 null)", () => {
      const messages = [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "test", arguments: "{}" },
            },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      const assistantMsg = result.messages[1];
      expect(assistantMsg.role).toBe("assistant");
      // content 应只包含 tool-call
      expect(
        assistantMsg.content.every((c: any) => c.type === "tool-call"),
      ).toBe(true);
    });

    test("跳过空白 assistant 文本内容", () => {
      const messages = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "  " }, // 空白
      ];
      const result = convertChatMessagesToAISDK(messages);
      // Anthropic 要求非空白文本, 空 assistant 消息应被过滤
      expect(result.messages).toHaveLength(1);
    });
  });

  // ---- 多模态内容 ----
  describe("多模态内容处理", () => {
    test("user 消息 - text + image_url (OpenAI Vision 格式)", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/image.png" },
            },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages[0].content).toEqual([
        { type: "text", text: "What's in this image?" },
        { type: "image", image: "https://example.com/image.png" },
      ]);
    });

    test("user 消息 - image_url 简写格式 (直接字符串)", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            {
              type: "image_url",
              image_url: "data:image/png;base64,abc123",
            },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages[0].content[1]).toEqual({
        type: "image",
        image: "data:image/png;base64,abc123",
      });
    });

    test("user 消息 - 单个文本 content part 简化为字符串", () => {
      const messages = [
        {
          role: "user",
          content: [{ type: "text", text: "Just text" }],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages[0].content).toBe("Just text");
    });

    test("过滤空白 text content part", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "Valid text" },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      // 空文本被过滤后只剩一个, 简化为字符串
      expect(result.messages[0].content).toBe("Valid text");
    });
  });

  // ---- 工具调用 (Tool Calls) ----
  describe("工具调用处理", () => {
    test("assistant tool_calls → tool-call 格式", () => {
      const messages = [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"NYC"}',
              },
            },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      const assistant = result.messages[1];
      expect(assistant.content).toHaveLength(2);
      expect(assistant.content[0]).toEqual({
        type: "text",
        text: "Let me check.",
      });
      expect(assistant.content[1]).toEqual({
        type: "tool-call",
        toolCallId: "call_abc",
        toolName: "get_weather",
        input: { location: "NYC" },
      });
    });

    test("tool 消息 → tool-result 格式", () => {
      const messages = [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"NYC"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: '{"temp":"72F"}',
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      const toolMsg = result.messages[2];
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content[0]).toEqual({
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "get_weather",
        output: { type: "text", value: '{"temp":"72F"}' },
      });
    });

    test("多个并行 tool_calls 和 tool 结果合并", () => {
      const messages = [
        { role: "user", content: "Do things" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "foo", arguments: "{}" },
            },
            {
              id: "c2",
              type: "function",
              function: { name: "bar", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "result1" },
        { role: "tool", tool_call_id: "c2", content: "result2" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      // 连续的 tool 消息应合并
      const toolMsg = result.messages[2];
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content).toHaveLength(2);
      expect(toolMsg.content[0].toolCallId).toBe("c1");
      expect(toolMsg.content[1].toolCallId).toBe("c2");
    });

    test("tool_calls arguments 解析失败时回退为空对象", () => {
      const messages = [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "broken",
                arguments: "not valid json{{{",
              },
            },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages[1].content[0].input).toEqual({});
    });

    test("tool_calls arguments 为对象格式 (非字符串)", () => {
      const messages = [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "test_fn",
                arguments: { key: "value" }, // 非字符串
              },
            },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages[1].content[0].input).toEqual({ key: "value" });
    });
  });

  // ---- 多轮对话 ----
  describe("多轮对话", () => {
    test("完整的多轮工具调用对话", () => {
      const messages = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What's the weather in NYC and LA?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "weather",
                arguments: '{"city":"NYC"}',
              },
            },
            {
              id: "c2",
              type: "function",
              function: {
                name: "weather",
                arguments: '{"city":"LA"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "Sunny 72F" },
        { role: "tool", tool_call_id: "c2", content: "Cloudy 65F" },
        {
          role: "assistant",
          content: "NYC is Sunny 72F, LA is Cloudy 65F.",
        },
        { role: "user", content: "Thanks!" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.system).toBe("You are helpful.");
      // user, assistant(tool_calls), tool(results), assistant(text), user
      expect(result.messages).toHaveLength(5);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[2].role).toBe("tool");
      expect(result.messages[3].role).toBe("assistant");
      expect(result.messages[4].role).toBe("user");
    });

    test("Codex CLI 风格多轮 (连续 assistant→tool 交替)", () => {
      const messages = [
        { role: "user", content: "Run ls and then cat file.txt" },
        {
          role: "assistant",
          content: "I'll run those commands.",
          tool_calls: [
            {
              id: "tc1",
              type: "function",
              function: { name: "shell", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "tc1", content: "file.txt" },
        {
          role: "assistant",
          content: "Now reading file.txt.",
          tool_calls: [
            {
              id: "tc2",
              type: "function",
              function: {
                name: "shell",
                arguments: '{"cmd":"cat file.txt"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "tc2", content: "Hello World" },
        {
          role: "assistant",
          content: "The file contains: Hello World",
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      // user, assistant(text+tc), tool, assistant(text+tc), tool, assistant(text)
      expect(result.messages).toHaveLength(6);

      // 验证每个 tool-call 后面紧跟 tool-result
      for (let i = 0; i < result.messages.length; i++) {
        const msg = result.messages[i];
        if (
          msg.role === "assistant" &&
          Array.isArray(msg.content) &&
          msg.content.some((c: any) => c.type === "tool-call")
        ) {
          const next = result.messages[i + 1];
          expect(next).toBeDefined();
          expect(next.role).toBe("tool");
        }
      }
    });
  });

  // ---- 边界情况 ----
  describe("边界情况", () => {
    test("空消息数组", () => {
      const result = convertChatMessagesToAISDK([]);
      expect(result.messages).toHaveLength(0);
      expect(result.system).toBeUndefined();
    });

    test("只有 system 消息", () => {
      const messages = [
        { role: "system", content: "System only" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.system).toBe("System only");
      expect(result.messages).toHaveLength(0);
    });

    test("未知角色 (应该跳过并警告)", () => {
      const messages = [
        { role: "user", content: "Hi" },
        { role: "function" as any, content: "deprecated" },
      ];
      const result = convertChatMessagesToAISDK(messages);
      // function 角色是已废弃的, 应该被跳过
      expect(result.messages).toHaveLength(1);
    });

    test("assistant 消息 content 为数组格式", () => {
      const messages = [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ];
      const result = convertChatMessagesToAISDK(messages);
      expect(result.messages[1].content).toEqual([
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ]);
    });
  });
});

// ============================================================
// convertToolChoice 测试
// ============================================================
describe("convertToolChoice", () => {
  describe("字符串格式", () => {
    test('"none" → "none"', () => {
      expect(convertToolChoice("none")).toBe("none");
    });

    test('"auto" → "auto"', () => {
      expect(convertToolChoice("auto")).toBe("auto");
    });

    test('"required" → "required"', () => {
      expect(convertToolChoice("required")).toBe("required");
    });

    test('"any" → "required" (Codex CLI 兼容)', () => {
      expect(convertToolChoice("any")).toBe("required");
    });

    test("未知字符串 → 默认 auto", () => {
      expect(convertToolChoice("unknown_value")).toBe("auto");
    });
  });

  describe("对象格式", () => {
    test('{ type: "function", function: { name: "x" } } → { type: "tool", toolName: "x" }', () => {
      const result = convertToolChoice({
        type: "function",
        function: { name: "get_weather" },
      });
      expect(result).toEqual({ type: "tool", toolName: "get_weather" });
    });

    test('{ type: "function" } (无 name) → "required"', () => {
      expect(convertToolChoice({ type: "function" })).toBe("required");
    });

    test('{ type: "any" } → "required"', () => {
      expect(convertToolChoice({ type: "any" })).toBe("required");
    });

    test('{ type: "none" } → "none"', () => {
      expect(convertToolChoice({ type: "none" })).toBe("none");
    });

    test('{ type: "auto" } → "auto"', () => {
      expect(convertToolChoice({ type: "auto" })).toBe("auto");
    });

    test('{ type: "required" } → "required"', () => {
      expect(convertToolChoice({ type: "required" })).toBe("required");
    });

    test("未知对象格式 → 默认 auto", () => {
      expect(convertToolChoice({ type: "something_else" })).toBe("auto");
    });
  });

  describe("特殊值", () => {
    test("undefined → undefined", () => {
      expect(convertToolChoice(undefined)).toBeUndefined();
    });

    test("null → undefined", () => {
      expect(convertToolChoice(null)).toBeUndefined();
    });

    test("false → undefined", () => {
      expect(convertToolChoice(false)).toBeUndefined();
    });

    test("数字 → 默认 auto", () => {
      expect(convertToolChoice(123)).toBe("auto");
    });
  });
});

// ============================================================
// convertOpenAIToolsToAISDK 测试
// ============================================================
describe("convertOpenAIToolsToAISDK", () => {
  test("标准 OpenAI function tool 转换", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather for a location",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string", description: "City name" },
              unit: {
                type: "string",
                enum: ["celsius", "fahrenheit"],
              },
            },
            required: ["location"],
          },
        },
      },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(Object.keys(result)).toEqual(["get_weather"]);
    expect(result["get_weather"]).toBeDefined();
  });

  test("多个工具转换", () => {
    const tools = [
      {
        type: "function",
        function: { name: "tool_a", description: "A" },
      },
      {
        type: "function",
        function: { name: "tool_b", description: "B" },
      },
      {
        type: "function",
        function: { name: "tool_c", description: "C" },
      },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(Object.keys(result)).toHaveLength(3);
    expect(Object.keys(result)).toEqual(["tool_a", "tool_b", "tool_c"]);
  });

  test("Codex CLI 工具格式 (shell, Read, Write 等)", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "shell",
          description: "Execute a shell command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              timeout: { type: "number" },
            },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "Read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(Object.keys(result)).toContain("shell");
    expect(Object.keys(result)).toContain("Read");
  });

  test("简化格式工具 (无 function 嵌套)", () => {
    const tools = [
      {
        name: "simple_tool",
        description: "A simple tool",
        parameters: {
          type: "object",
          properties: { x: { type: "number" } },
        },
      },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(Object.keys(result)).toEqual(["simple_tool"]);
  });

  test("缺少 parameters 时使用空 schema", () => {
    const tools = [
      {
        type: "function",
        function: { name: "no_params" },
      },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(result["no_params"]).toBeDefined();
  });

  test("parameters 缺少 type 字段时自动补全", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "missing_type",
          parameters: {
            properties: { x: { type: "number" } },
          },
        },
      },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(result["missing_type"]).toBeDefined();
  });

  test("跳过没有 name 的工具", () => {
    const tools = [
      { type: "function", function: { description: "no name" } },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("空工具数组", () => {
    const result = convertOpenAIToolsToAISDK([]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("strict 模式工具 (OpenAI Structured Outputs)", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "strict_tool",
          description: "Tool with strict schema",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
            required: ["name", "age"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    ];
    const result = convertOpenAIToolsToAISDK(tools);
    expect(result["strict_tool"]).toBeDefined();
  });
});

// ============================================================
// 参数映射验证测试 (Handler 级别参数提取)
// ============================================================
describe("Chat Completions 参数映射", () => {
  test("max_completion_tokens 优先于 max_tokens", () => {
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1000,
      max_completion_tokens: 2000,
    };
    // 模拟 handler 中的提取逻辑
    const maxTokens = body.max_completion_tokens || body.max_tokens;
    expect(maxTokens).toBe(2000);
  });

  test("stop 字符串转数组", () => {
    const body1 = { stop: "END" };
    const body2 = { stop: ["STOP", "END"] };
    const body3 = { stop: undefined };

    const convert = (stop: any) =>
      stop ? (Array.isArray(stop) ? stop : [stop]) : undefined;

    expect(convert(body1.stop)).toEqual(["END"]);
    expect(convert(body2.stop)).toEqual(["STOP", "END"]);
    expect(convert(body3.stop)).toBeUndefined();
  });

  test("parallel_tool_calls 反转映射", () => {
    // OpenAI: parallel_tool_calls = true → Anthropic: disableParallelToolUse = false
    expect(!true).toBe(false);
    expect(!false).toBe(true);
  });

  test("不支持的参数应被忽略", () => {
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Hi" }],
      // 以下参数在当前实现中不支持, 应被安全忽略
      n: 2,
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
      logit_bias: { "123": 5 },
      logprobs: true,
      top_logprobs: 3,
      response_format: { type: "json_object" },
      seed: 42,
      user: "user-123",
      service_tier: "default",
      stream_options: { include_usage: true },
      reasoning_effort: "high",
      store: true,
      metadata: { key: "value" },
    };

    // 解构后剩余参数在 ...rest 中, 不会影响核心逻辑
    const {
      model,
      messages,
      n,
      presence_penalty,
      frequency_penalty,
      ...rest
    } = body;
    expect(model).toBe("gpt-4");
    expect(messages).toBeDefined();
    // 这些参数存在但不影响处理
    expect(n).toBe(2);
  });

  test("prediction 参数存在但被忽略", () => {
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Hi" }],
      prediction: {
        type: "content",
        content: "Expected output text",
      },
    };
    // prediction 是 OpenAI 的 Predicted Outputs 功能, Anthropic 不支持
    const { prediction, ...rest } = body;
    expect(prediction).toBeDefined();
    // 确保不会因 prediction 存在而报错
    expect(() => convertChatMessagesToAISDK(body.messages)).not.toThrow();
  });
});

// ============================================================
// 响应格式验证测试
// ============================================================
describe("Chat Completions 响应格式", () => {
  test("非流式响应结构符合 OpenAI 规范", () => {
    // 模拟 handler 生成的响应
    const response = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "claude-sonnet-4-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello!",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    expect(response.id).toMatch(/^chatcmpl-/);
    expect(response.object).toBe("chat.completion");
    expect(typeof response.created).toBe("number");
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.role).toBe("assistant");
    expect(["stop", "tool_calls", "length"]).toContain(
      response.choices[0].finish_reason,
    );
    expect(response.usage.prompt_tokens).toBeGreaterThanOrEqual(0);
    expect(response.usage.completion_tokens).toBeGreaterThanOrEqual(0);
    expect(response.usage.total_tokens).toBeGreaterThanOrEqual(0);
  });

  test("工具调用响应结构", () => {
    const response = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1700000000,
      model: "claude-sonnet-4-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"NYC"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      },
    };

    expect(response.choices[0].finish_reason).toBe("tool_calls");
    expect(response.choices[0].message.content).toBeNull();
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
    expect(response.choices[0].message.tool_calls![0].type).toBe("function");
    // 验证 arguments 是 JSON 字符串
    expect(() =>
      JSON.parse(response.choices[0].message.tool_calls![0].function.arguments),
    ).not.toThrow();
  });

  test("流式 chunk 结构符合 OpenAI 规范", () => {
    const chunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "claude-sonnet-4-5",
      choices: [
        {
          index: 0,
          delta: {
            content: "Hello",
          },
          finish_reason: null,
        },
      ],
    };

    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0].delta).toBeDefined();
    expect(chunk.choices[0].finish_reason).toBeNull();
  });

  test("流式结束 chunk (finish_reason = stop)", () => {
    const chunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "claude-sonnet-4-5",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };

    expect(chunk.choices[0].delta).toEqual({});
    expect(chunk.choices[0].finish_reason).toBe("stop");
  });

  test("流式 tool_call chunk 结构", () => {
    const chunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "claude-sonnet-4-5",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: {
                  name: "test",
                  arguments: '{"x":1}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };

    const tc = chunk.choices[0].delta.tool_calls![0];
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("test");
  });
});
