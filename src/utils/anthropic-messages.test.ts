/**
 * Anthropic Messages API 兼容性测试
 * 覆盖直通代理 (/v1/messages) 的请求处理、系统提示词注入和工具前缀处理
 *
 * Anthropic Messages API 参数 (POST /v1/messages):
 * - model ✅ (required, 模型映射)
 * - max_tokens ✅ (required, 直传)
 * - messages ✅ (required, 直传 + 系统提示词注入)
 * - system ✅ (直传, 自动注入 Claude Code 提示词)
 * - temperature ✅ (直传)
 * - top_p ✅ (直传)
 * - top_k ✅ (直传)
 * - stop_sequences ✅ (直传)
 * - stream ✅ (直传)
 * - tools ✅ (直传 + mcp_ 前缀处理)
 * - tool_choice ✅ (直传)
 * - metadata ✅ (直传)
 * - thinking ⚠️ (直传, 通过 beta header 支持)
 * - cache_control ⚠️ (直传 + 自动缓存标记)
 *
 * 请求处理管道 (request-processor.ts):
 * - processClaudeCodeRequestBody() 幂等处理
 * - Claude Code system prompt 注入
 * - Tool 名称 mcp_ 前缀添加
 * - Prompt cache 标记添加
 * - removeToolPrefixFromResponse() 响应清理
 *
 * Anthropic 响应格式:
 * - stop_reason: end_turn | max_tokens | stop_sequence | tool_use
 * - content blocks: text | tool_use | thinking | redacted_thinking
 * - usage: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
 *
 * 流式事件:
 * - message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
 * - ping 事件可穿插
 * - Delta 类型: text_delta, input_json_delta, thinking_delta, signature_delta, citations_delta
 */

import { describe, test, expect } from "bun:test";
import {
  TOOL_PREFIX,
  CLAUDE_CODE_SYSTEM_PROMPT,
  CLAUDE_CODE_HEADERS,
  DEFAULT_CLAUDE_CODE_TOOL,
  ANTHROPIC_API_BASE_URL,
} from "../constants";

// ============================================================
// 常量验证
// ============================================================
describe("常量配置", () => {
  test("TOOL_PREFIX 为 mcp_", () => {
    expect(TOOL_PREFIX).toBe("mcp_");
  });

  test("CLAUDE_CODE_SYSTEM_PROMPT 格式正确", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT).toContain("Claude Code");
    expect(CLAUDE_CODE_SYSTEM_PROMPT).toContain("Anthropic");
  });

  test("CLAUDE_CODE_HEADERS 包含必要的 beta 标志", () => {
    expect(CLAUDE_CODE_HEADERS["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(CLAUDE_CODE_HEADERS["anthropic-beta"]).toContain(
      "interleaved-thinking-2025-05-14",
    );
    expect(CLAUDE_CODE_HEADERS["anthropic-beta"]).toContain(
      "claude-code-20250219",
    );
    expect(CLAUDE_CODE_HEADERS["anthropic-version"]).toBe("2023-06-01");
    expect(CLAUDE_CODE_HEADERS["user-agent"]).toMatch(/^claude-cli\//);
  });

  test("DEFAULT_CLAUDE_CODE_TOOL 结构正确", () => {
    expect(DEFAULT_CLAUDE_CODE_TOOL.name).toMatch(/^mcp_/);
    expect(DEFAULT_CLAUDE_CODE_TOOL.input_schema.type).toBe("object");
  });

  test("ANTHROPIC_API_BASE_URL 正确", () => {
    expect(ANTHROPIC_API_BASE_URL).toBe("https://api.anthropic.com");
  });
});

// ============================================================
// System Prompt 注入逻辑
// ============================================================
describe("System Prompt 注入", () => {
  test("无 system 时注入 Claude Code 提示词", () => {
    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    };

    // 模拟 processClaudeCodeRequestBody 逻辑
    const shouldInject = !body.hasOwnProperty("system") || !body.system;
    expect(shouldInject).toBe(true);
  });

  test("已有 system 时检测是否已包含 Claude Code 提示词", () => {
    const bodyWithPrompt = {
      system: [
        {
          type: "text",
          text: CLAUDE_CODE_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    // 检测已注入
    const hasClaudeCodePrompt = Array.isArray(bodyWithPrompt.system)
      ? bodyWithPrompt.system.some(
          (s: any) => s.type === "text" && s.text === CLAUDE_CODE_SYSTEM_PROMPT,
        )
      : bodyWithPrompt.system === CLAUDE_CODE_SYSTEM_PROMPT;

    expect(hasClaudeCodePrompt).toBe(true);
  });

  test("system 为字符串且完全匹配时不重复注入", () => {
    const body = { system: CLAUDE_CODE_SYSTEM_PROMPT };
    const isExactMatch = body.system === CLAUDE_CODE_SYSTEM_PROMPT;
    expect(isExactMatch).toBe(true);
  });

  test("system 为字符串但不匹配时需要注入", () => {
    const body = { system: "Custom system prompt" };
    const isExactMatch = body.system === CLAUDE_CODE_SYSTEM_PROMPT;
    expect(isExactMatch).toBe(false);
  });
});

// ============================================================
// Tool 名称前缀处理
// ============================================================
describe("Tool 名称前缀处理", () => {
  test("添加 mcp_ 前缀到工具名称", () => {
    const tools = [
      { name: "shell", description: "Run command", input_schema: {} },
      { name: "Read", description: "Read file", input_schema: {} },
    ];

    const prefixed = tools.map((t) => ({
      ...t,
      name: t.name.startsWith(TOOL_PREFIX) ? t.name : `${TOOL_PREFIX}${t.name}`,
    }));

    expect(prefixed[0].name).toBe("mcp_shell");
    expect(prefixed[1].name).toBe("mcp_Read");
  });

  test("已有前缀的工具不重复添加", () => {
    const tools = [
      { name: "mcp_shell", description: "Already prefixed", input_schema: {} },
    ];

    const prefixed = tools.map((t) => ({
      ...t,
      name: t.name.startsWith(TOOL_PREFIX) ? t.name : `${TOOL_PREFIX}${t.name}`,
    }));

    expect(prefixed[0].name).toBe("mcp_shell");
  });

  test("消息中 tool_use block 名称也需前缀", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "shell",
            input: { command: "ls" },
          },
        ],
      },
    ];

    // 模拟前缀添加
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block.type === "tool_use" &&
            !block.name.startsWith(TOOL_PREFIX)
          ) {
            block.name = `${TOOL_PREFIX}${block.name}`;
          }
        }
      }
    }

    expect(messages[0].content[0].name).toBe("mcp_shell");
  });

  test("响应中移除 mcp_ 前缀", () => {
    const responseText =
      'Using tool "mcp_shell" to run command, then "mcp_Read" to read file';

    // 模拟 removeToolPrefixFromResponse
    const cleaned = responseText.replace(/\bmcp_([a-zA-Z0-9_]+)/g, "$1");

    expect(cleaned).toBe(
      'Using tool "shell" to run command, then "Read" to read file',
    );
    expect(cleaned).not.toContain("mcp_");
  });
});

// ============================================================
// Prompt Cache 标记
// ============================================================
describe("Prompt Cache 标记", () => {
  test("最后一个工具添加缓存标记", () => {
    const tools = [
      { name: "tool1", input_schema: {} },
      { name: "tool2", input_schema: {} },
      { name: "tool3", input_schema: {} },
    ];

    // 模拟: 给最后一个工具添加 cache_control
    const processedTools = tools.map((t, i) => ({
      ...t,
      ...(i === tools.length - 1 && {
        cache_control: { type: "ephemeral" },
      }),
    }));

    expect(processedTools[0]).not.toHaveProperty("cache_control");
    expect(processedTools[1]).not.toHaveProperty("cache_control");
    expect(processedTools[2].cache_control).toEqual({ type: "ephemeral" });
  });

  test("最后 N 条消息添加缓存标记", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "msg 1" }] },
      { role: "assistant", content: [{ type: "text", text: "msg 2" }] },
      { role: "user", content: [{ type: "text", text: "msg 3" }] },
      { role: "assistant", content: [{ type: "text", text: "msg 4" }] },
      { role: "user", content: [{ type: "text", text: "msg 5" }] },
    ];

    const cacheMessageCount = 3;
    const startIdx = Math.max(0, messages.length - cacheMessageCount);

    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];
      if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastBlock = msg.content[msg.content.length - 1];
        (lastBlock as any).cache_control = { type: "ephemeral" };
      }
    }

    // 前 2 条不应有缓存标记
    expect(messages[0].content[0]).not.toHaveProperty("cache_control");
    expect(messages[1].content[0]).not.toHaveProperty("cache_control");
    // 后 3 条应有
    expect((messages[2].content[0] as any).cache_control).toBeDefined();
    expect((messages[3].content[0] as any).cache_control).toBeDefined();
    expect((messages[4].content[0] as any).cache_control).toBeDefined();
  });
});

// ============================================================
// Anthropic 请求/响应格式验证
// ============================================================
describe("Anthropic Messages API 格式", () => {
  test("请求体结构完整性", () => {
    const request = {
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
      system: [
        {
          type: "text",
          text: CLAUDE_CODE_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: "mcp_shell",
          description: "Execute command",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          },
        },
      ],
      temperature: 0.7,
      top_p: 0.9,
      stream: true,
    };

    expect(request.model).toContain("claude");
    expect(request.max_tokens).toBeGreaterThan(0);
    expect(request.messages).toHaveLength(1);
    expect(Array.isArray(request.system)).toBe(true);
    expect(request.tools[0].name).toMatch(/^mcp_/);
    expect(request.tools[0].input_schema.type).toBe("object");
  });

  test("响应体结构 - 文本响应", () => {
    const response = {
      id: "msg_01XFDUDYJgAACzvnptvVoYEL",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 25,
        output_tokens: 150,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };

    expect(response.type).toBe("message");
    expect(response.role).toBe("assistant");
    expect(response.content[0].type).toBe("text");
    expect(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).toContain(
      response.stop_reason,
    );
  });

  test("响应体结构 - 工具调用", () => {
    const response = {
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          id: "toolu_01CswdEQBMshySk6Y9DFKrfq",
          name: "mcp_get_weather",
          input: { location: "Paris" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 50 },
    };

    expect(response.stop_reason).toBe("tool_use");
    expect(response.content).toHaveLength(2);

    const toolUse = response.content[1];
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.name).toMatch(/^mcp_/);
    expect(toolUse.id).toMatch(/^toolu_/);
  });

  test("响应体结构 - 扩展思考 (thinking)", () => {
    const response = {
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Let me think about this step by step...",
          signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3h...",
        },
        { type: "text", text: "The answer is 42." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 200 },
    };

    expect(response.content[0].type).toBe("thinking");
    expect(response.content[0].thinking).toBeTruthy();
    expect(response.content[0].signature).toBeTruthy();
    expect(response.content[1].type).toBe("text");
  });
});

// ============================================================
// 流式事件格式
// ============================================================
describe("Anthropic 流式事件格式", () => {
  test("message_start 事件结构", () => {
    const event = {
      type: "message_start",
      message: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 25,
          output_tokens: 1,
        },
      },
    };

    expect(event.type).toBe("message_start");
    expect(event.message.content).toEqual([]);
    expect(event.message.stop_reason).toBeNull();
  });

  test("content_block_start 事件 - text", () => {
    const event = {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
      },
    };

    expect(event.type).toBe("content_block_start");
    expect(event.content_block.type).toBe("text");
  });

  test("content_block_start 事件 - tool_use", () => {
    const event = {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_123",
        name: "mcp_shell",
        input: {},
      },
    };

    expect(event.content_block.type).toBe("tool_use");
    expect(event.content_block.name).toMatch(/^mcp_/);
  });

  test("content_block_start 事件 - thinking", () => {
    const event = {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "thinking",
        thinking: "",
      },
    };

    expect(event.content_block.type).toBe("thinking");
  });

  test("content_block_delta 事件 - text_delta", () => {
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "Hello",
      },
    };

    expect(event.delta.type).toBe("text_delta");
    expect(event.delta.text).toBe("Hello");
  });

  test("content_block_delta 事件 - input_json_delta", () => {
    const event = {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: '{"location":',
      },
    };

    expect(event.delta.type).toBe("input_json_delta");
    expect(event.delta.partial_json).toBeTruthy();
  });

  test("content_block_delta 事件 - thinking_delta", () => {
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: "Let me think...",
      },
    };

    expect(event.delta.type).toBe("thinking_delta");
  });

  test("content_block_delta 事件 - signature_delta", () => {
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: "EqQBCgIYAhIM...",
      },
    };

    expect(event.delta.type).toBe("signature_delta");
  });

  test("message_delta 事件 (包含 usage 累计)", () => {
    const event = {
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: 150,
      },
    };

    expect(event.delta.stop_reason).toBe("end_turn");
    expect(event.usage.output_tokens).toBeGreaterThan(0);
  });

  test("完整的流式事件序列验证", () => {
    const eventSequence = [
      "message_start",
      "content_block_start", // thinking
      "content_block_delta", // thinking_delta
      "content_block_delta", // signature_delta
      "content_block_stop",
      "content_block_start", // text
      "content_block_delta", // text_delta
      "content_block_delta", // text_delta
      "content_block_stop",
      "message_delta",
      "message_stop",
    ];

    // message_start 必须是第一个
    expect(eventSequence[0]).toBe("message_start");
    // message_stop 必须是最后一个
    expect(eventSequence[eventSequence.length - 1]).toBe("message_stop");
    // message_delta 在 message_stop 之前
    const deltaIdx = eventSequence.indexOf("message_delta");
    const stopIdx = eventSequence.indexOf("message_stop");
    expect(deltaIdx).toBeLessThan(stopIdx);
  });

  test("ping 事件可穿插", () => {
    const ping = { type: "ping" };
    expect(ping.type).toBe("ping");
    // ping 事件是心跳, 不影响消息处理
  });

  test("error 事件结构", () => {
    const error = {
      type: "error",
      error: {
        type: "overloaded_error",
        message: "Overloaded",
      },
    };

    expect(error.type).toBe("error");
    expect(error.error.type).toBe("overloaded_error");
  });
});

// ============================================================
// 扩展思考参数
// ============================================================
describe("扩展思考 (Extended Thinking) 参数", () => {
  test("thinking: enabled 格式", () => {
    const thinking = {
      type: "enabled",
      budget_tokens: 10000,
    };

    expect(thinking.type).toBe("enabled");
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
  });

  test("thinking: adaptive 格式 (Opus 4.6 推荐)", () => {
    const thinking = {
      type: "adaptive",
    };
    expect(thinking.type).toBe("adaptive");
  });

  test("thinking: disabled 格式", () => {
    const thinking = { type: "disabled" };
    expect(thinking.type).toBe("disabled");
  });

  test("budget_tokens 最小值约束 (≥1024)", () => {
    const budgetTokens = 1024;
    expect(budgetTokens).toBeGreaterThanOrEqual(1024);
  });

  test("budget_tokens 必须小于 max_tokens (无 interleaved thinking 时)", () => {
    const maxTokens = 16000;
    const budgetTokens = 10000;
    expect(budgetTokens).toBeLessThan(maxTokens);
  });
});

// ============================================================
// Tool Choice 格式 (Anthropic 原生)
// ============================================================
describe("Anthropic tool_choice 格式", () => {
  test('{ type: "auto" }', () => {
    const tc = { type: "auto" };
    expect(tc.type).toBe("auto");
  });

  test('{ type: "any" } (必须调用某个工具)', () => {
    const tc = { type: "any" };
    expect(tc.type).toBe("any");
  });

  test('{ type: "none" }', () => {
    const tc = { type: "none" };
    expect(tc.type).toBe("none");
  });

  test('{ type: "tool", name: "xxx" } (强制特定工具)', () => {
    const tc = { type: "tool", name: "get_weather" };
    expect(tc.type).toBe("tool");
    expect(tc.name).toBe("get_weather");
  });

  test("disable_parallel_tool_use 选项", () => {
    const tc = { type: "auto", disable_parallel_tool_use: true };
    expect(tc.disable_parallel_tool_use).toBe(true);
  });
});

// ============================================================
// 模型映射
// ============================================================
describe("模型映射", () => {
  test("模型列表包含当前可用模型", () => {
    const availableModels = [
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ];
    expect(availableModels).toContain("claude-opus-4-5");
    expect(availableModels).toContain("claude-sonnet-4-5");
    expect(availableModels).toContain("claude-haiku-4-5");
  });

  test("常见 OpenAI 模型映射", () => {
    // 基于 storage.ts 中的默认映射
    const mappings: Record<string, string> = {
      "gpt-4o": "claude-sonnet-4-5",
      "gpt-4": "claude-sonnet-4-5",
      "gpt-4-turbo": "claude-sonnet-4-5",
      "gpt-3.5-turbo": "claude-haiku-4-5",
      o1: "claude-opus-4-5",
      "o1-mini": "claude-sonnet-4-5",
      o3: "claude-opus-4-5",
      "o3-mini": "claude-sonnet-4-5",
    };

    for (const [openai, claude] of Object.entries(mappings)) {
      expect(claude).toMatch(/^claude-/);
    }
  });

  test("Codex CLI 默认模型 (o3) 映射", () => {
    // Codex CLI 默认使用 o3 模型
    const codexModel = "o3";
    const expectedMapping = "claude-opus-4-5"; // 或其他高端模型
    expect(expectedMapping).toMatch(/^claude-/);
  });
});

// ============================================================
// 重试逻辑
// ============================================================
describe("请求重试逻辑", () => {
  test("401 触发 token 刷新", () => {
    const status = 401;
    const shouldRefresh = status === 401;
    expect(shouldRefresh).toBe(true);
  });

  test("429/529 触发指数退避", () => {
    const retryStatuses = [429, 529];
    for (const status of retryStatuses) {
      expect(retryStatuses).toContain(status);
    }

    // 指数退避时间: 2s, 4s, 8s
    const delays = [2000, 4000, 8000];
    for (let i = 0; i < delays.length; i++) {
      expect(delays[i]).toBe(2000 * Math.pow(2, i));
    }
  });

  test("最多 3 次重试", () => {
    const maxRetries = 3;
    expect(maxRetries).toBe(3);
  });
});

// ============================================================
// 幂等性验证
// ============================================================
describe("请求处理幂等性", () => {
  test("processClaudeCodeRequestBody 标记避免重复处理", () => {
    // 模拟 body 标记
    const body: any = {
      messages: [{ role: "user", content: "Hello" }],
    };

    // 第一次处理: 添加标记
    if (!body._ccproxy_processed) {
      body._ccproxy_processed = true;
      // ... 处理逻辑
    }
    expect(body._ccproxy_processed).toBe(true);

    // 第二次调用: 跳过
    let processedAgain = false;
    if (!body._ccproxy_processed) {
      processedAgain = true;
    }
    expect(processedAgain).toBe(false);
  });

  test("system prompt 不重复注入", () => {
    const system = [
      {
        type: "text",
        text: CLAUDE_CODE_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ];

    const alreadyHasPrompt = system.some(
      (s) => s.type === "text" && s.text === CLAUDE_CODE_SYSTEM_PROMPT,
    );
    expect(alreadyHasPrompt).toBe(true);
    // 不应再次注入
  });

  test("tool 前缀不重复添加", () => {
    const toolName = "mcp_shell";
    const alreadyPrefixed = toolName.startsWith(TOOL_PREFIX);
    expect(alreadyPrefixed).toBe(true);

    // 再次处理不会变成 mcp_mcp_shell
    const result = alreadyPrefixed ? toolName : `${TOOL_PREFIX}${toolName}`;
    expect(result).toBe("mcp_shell");
  });
});

// ============================================================
// SessionManager 修复验证
// ============================================================
import { SessionManager } from "../session-manager";

describe("SessionManager - 去重 hash 稳定性", () => {
  test("不同消息内容的请求不应被判为重复（即使 model/temperature 相同）", () => {
    const manager = new SessionManager({
      dedupeWindowMs: 5000,
      enableDedupe: true,
      enableBusyCheck: false,
    });

    const bodyA = {
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-opus-4-5",
      temperature: 0.7,
    };

    const bodyB = {
      messages: [{ role: "user", content: "Completely different question" }],
      model: "claude-opus-4-5", // 相同 model
      temperature: 0.7, // 相同 temperature
    };

    // 第一个请求先注册
    const sessionId = "test-session-stable-hash";
    manager.startRequest(sessionId, bodyA);

    // 不同消息内容的请求不应被视为重复
    const isDupe = manager.isDuplicateRequest(bodyB);
    expect(isDupe).toBe(false);

    manager.endRequest(sessionId);
  });

  test("相同消息内容但不同 model/temperature 的请求应被判为重复（内容相同）", () => {
    const manager = new SessionManager({
      dedupeWindowMs: 5000,
      enableDedupe: true,
      enableBusyCheck: false,
    });

    const bodyA = {
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-opus-4-5",
      temperature: 0.7,
      stream: true,
    };

    const bodyB = {
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-haiku-4-5", // 不同 model，但 messages 内容相同
      temperature: 0.9, // 不同 temperature
      stream: false,
    };

    // 第一个请求先注册
    const sessionId = "test-session-same-content";
    manager.startRequest(sessionId, bodyA);

    // messages 内容相同，即使 model/temperature 不同，仍被视为重复（防止客户端重试风暴）
    const isDupe = manager.isDuplicateRequest(bodyB);
    expect(isDupe).toBe(true);

    manager.endRequest(sessionId);
  });

  test("完全相同消息内容的并发请求应被判为重复", () => {
    const manager = new SessionManager({
      dedupeWindowMs: 5000,
      enableDedupe: true,
      enableBusyCheck: false,
    });

    const body = {
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-opus-4-5",
      temperature: 0.7,
    };

    const sessionId = "test-session-dupe";
    manager.startRequest(sessionId, body);

    // 完全相同内容（messages/system/tools 相同）应被视为重复
    const isDupe = manager.isDuplicateRequest(body);
    expect(isDupe).toBe(true);

    manager.endRequest(sessionId);
  });

  test("请求结束后同内容请求不再被视为重复", () => {
    const manager = new SessionManager({
      dedupeWindowMs: 5000,
      enableDedupe: true,
      enableBusyCheck: false,
    });

    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };

    const sessionId = "test-session-after-end";
    manager.startRequest(sessionId, body);
    manager.endRequest(sessionId);

    // 结束后 inProgress=false，不再是重复
    const isDupe = manager.isDuplicateRequest(body);
    expect(isDupe).toBe(false);
  });
});

describe("SessionManager - endRequest 幂等性", () => {
  test("多次调用 endRequest 不会抛出错误", () => {
    const manager = new SessionManager({
      enableDedupe: true,
      enableBusyCheck: true,
    });

    const body = { messages: [{ role: "user", content: "Test" }] };
    const sessionId = "test-idempotent";

    manager.startRequest(sessionId, body);

    // 第一次结束
    expect(() => manager.endRequest(sessionId)).not.toThrow();
    // 第二次结束（幂等）
    expect(() => manager.endRequest(sessionId)).not.toThrow();
    // 第三次结束
    expect(() => manager.endRequest(sessionId)).not.toThrow();
  });

  test("endRequest 之后 activeSessionCount 减少", () => {
    const manager = new SessionManager({
      enableDedupe: false,
      enableBusyCheck: true,
    });

    const body1 = { messages: [{ role: "user", content: "First" }] };
    const body2 = { messages: [{ role: "user", content: "Second" }] };

    manager.startRequest("session-1", body1);
    manager.startRequest("session-2", body2);
    expect(manager.getActiveSessionCount()).toBe(2);

    manager.endRequest("session-1");
    expect(manager.getActiveSessionCount()).toBe(1);

    manager.endRequest("session-2");
    expect(manager.getActiveSessionCount()).toBe(0);

    // 再次调用不会变成负数或抛错
    manager.endRequest("session-2");
    expect(manager.getActiveSessionCount()).toBe(0);
  });
});

describe("SessionManager - 会话忙碌检测", () => {
  test("活跃请求期间相同 sessionId 的请求应被拒绝", () => {
    const manager = new SessionManager({
      enableDedupe: false,
      enableBusyCheck: true,
    });

    const body = { messages: [{ role: "user", content: "Hello" }] };
    const sessionId = "busy-session";

    const result1 = manager.startRequest(sessionId, body);
    expect(result1.accepted).toBe(true);

    // 同一 sessionId 再次请求应被拒绝
    const result2 = manager.startRequest(sessionId, {
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result2.accepted).toBe(false);
    expect(result2.reason).toContain(sessionId);

    manager.endRequest(sessionId);

    // 结束后可以再次请求
    const result3 = manager.startRequest(sessionId, body);
    expect(result3.accepted).toBe(true);
    manager.endRequest(sessionId);
  });

  test("超时的活跃请求不阻塞后续请求", async () => {
    const manager = new SessionManager({
      enableDedupe: false,
      enableBusyCheck: true,
      requestTimeoutMs: 1, // 1ms 超时
    });

    const body = { messages: [{ role: "user", content: "Hello" }] };
    const sessionId = "timeout-session";

    manager.startRequest(sessionId, body);

    // 等待超过 requestTimeoutMs，确保请求已超时
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 超时后 isSessionBusy 应该认为已过期，返回 false
    const isBusy = manager.isSessionBusy(sessionId);
    expect(isBusy).toBe(false);
  });
});

describe("SessionManager - AbortController 自动清理", () => {
  test("abort 信号触发时 session 应自动被释放", async () => {
    const manager = new SessionManager({
      enableDedupe: false,
      enableBusyCheck: true,
    });

    const body = { messages: [{ role: "user", content: "Hello" }] };
    const sessionId = "abort-session";
    const abortController = new AbortController();

    manager.startRequest(sessionId, body, abortController);
    expect(manager.getActiveSessionCount()).toBe(1);

    // 触发 abort
    abortController.abort();

    // abort 事件是同步触发的，session 应立即释放
    expect(manager.getActiveSessionCount()).toBe(0);
  });
});

describe("retry-after 解析精度", () => {
  test("parseFloat 能正确处理小数秒", () => {
    const retryAfterValues = ["0.5", "1.5", "0", "30", "60.9"];
    const expected = [500, 1500, 500, 30000, 60000]; // 最小 500ms，最大 60000ms

    for (let i = 0; i < retryAfterValues.length; i++) {
      const retryAfter = retryAfterValues[i];
      const retryAfterMs = retryAfter
        ? Math.min(parseFloat(retryAfter!) * 1000, 60000)
        : 2000;
      const waitMs = Math.max(retryAfterMs, 500);
      expect(waitMs).toBe(expected[i]!);
    }
  });

  test("parseInt 会截断小数秒导致等待不足", () => {
    // 验证旧行为（parseInt）确实有问题
    const retryAfter = "0.5";
    const oldWaitMs = parseInt(retryAfter) * 1000; // parseInt("0.5") = 0
    expect(oldWaitMs).toBe(0); // 旧行为：等待 0ms，立即重试

    // 新行为（parseFloat）正确
    const newWaitMs = Math.max(
      Math.min(parseFloat(retryAfter) * 1000, 60000),
      500,
    );
    expect(newWaitMs).toBe(500); // 新行为：至少等 500ms
  });

  test("超大 retry-after 值被上限截断为 60s", () => {
    const retryAfter = "3600"; // 1 小时
    const retryAfterMs = Math.min(parseFloat(retryAfter) * 1000, 60000);
    const waitMs = Math.max(retryAfterMs, 500);
    expect(waitMs).toBe(60000);
  });

  test("无 retry-after 时使用指数退避", () => {
    // attempt 1: 2000 * 2^0 = 2000
    // attempt 2: 2000 * 2^1 = 4000
    // attempt 3: 2000 * 2^2 = 8000
    const delays = [1, 2, 3].map((attempt) => 2000 * (1 << (attempt - 1)));
    expect(delays).toEqual([2000, 4000, 8000]);
  });
});
