/**
 * CCProxy 常量定义模块
 */

/** Tool 名称前缀 */
export const TOOL_PREFIX = "mcp_";

/** Claude Code 系统提示词 */
export const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Claude Code API 请求 Headers */
export const CLAUDE_CODE_HEADERS = {
  "anthropic-beta":
    "oauth-2025-04-20,interleaved-thinking-2025-05-14,claude-code-20250219",
  "user-agent": "claude-cli/2.1.2 (external, cli)",
  "anthropic-version": "2023-06-01",
};

/** 默认的 placeholder tool，用于确保请求被识别为 Claude Code 请求 */
export const DEFAULT_CLAUDE_CODE_TOOL = {
  name: "mcp_placeholder",
  description: "Placeholder tool for Claude Code compatibility",
  input_schema: {
    type: "object",
    properties: {},
  },
};

/** Anthropic API 基础 URL */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/** 请求超时时间 (毫秒) */
export const REQUEST_TIMEOUT = 120000; // 2 minutes
