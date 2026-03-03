# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CCProxy 是一个 Claude Code 订阅代理服务器，通过 Claude Pro/Max 订阅的 OAuth 凭证，将标准 API 端点暴露给客户端。支持三种 API 格式：OpenAI Chat Completions、OpenAI Responses API、Anthropic Messages API。

**运行时**: Bun | **框架**: Hono | **语言**: TypeScript

## Build & Dev Commands

```bash
# 安装依赖
bun install

# 开发模式（watch 热重载）
bun run dev

# 启动服务器
bun run start                         # 默认端口
bun run src/cli.ts start -p 3456      # 指定端口

# OAuth 登录
bun run login
bun run src/cli.ts login --mode max   # Max 订阅模式

# 构建可执行文件（Windows + Linux）
bun run build
bun run build:windows                 # 仅 Windows
bun run build:linux                   # 仅 Linux

# 运行测试
bun test
bun test src/utils/openai-converter.test.ts  # 运行单个测试

# CLI 管理命令
bun run src/cli.ts status             # 认证状态
bun run src/cli.ts config show        # 查看配置
bun run src/cli.ts apikey generate    # 生成 API Key
```

## Architecture

### 请求处理管道

```
客户端请求 → API Key 中间件 → 会话去重/并发检查 → 格式转换(OpenAI→AI SDK)
→ 模型名称映射 → Claude Code 系统提示词注入 → Anthropic API 调用
→ SSE 流式/JSON 响应 → Langfuse 追踪(可选) → Token 统计(可选)
```

### 核心模块职责

| 模块 | 路径 | 职责 |
|------|------|------|
| **认证** | `src/auth.ts` | OAuth 2.0 + PKCE 流程，Token 交换与被动刷新 |
| **存储** | `src/storage.ts` | 凭证(`~/.ccproxy/auth.json`)、配置、API Key 持久化 |
| **服务器** | `src/server.ts` | Hono 路由组装、中间件链、优雅关闭 |
| **CLI** | `src/cli.ts` | 入口点：login/start/status/config/apikey 子命令 |
| **会话管理** | `src/session-manager.ts` | 并发控制、请求去重(2s窗口)、超时管理 |
| **配置监控** | `src/config-watcher.ts` | `fs.watch` 热重载配置，防抖处理 |
| **追踪** | `src/langfuse.ts` | Langfuse 可观测性集成 |
| **统计** | `src/stats.ts` | Token 使用量记录与上报 |

### Handlers（API 端点处理器）

- `src/handlers/chat-completions.ts` → `/v1/chat/completions` (OpenAI 兼容)
- `src/handlers/responses.ts` → `/v1/responses` (OpenAI Responses API)
- `src/handlers/messages.ts` → `/v1/messages` (Anthropic 原生)
- `src/handlers/models.ts` → `/v1/models` (模型列表)

### Utils（核心转换逻辑）

- `src/utils/openai-converter.ts` — OpenAI 格式 → AI SDK 格式转换，处理 System 消息合并、Tool Calls 转换、Tool Results 匹配、多模态内容
- `src/utils/request-processor.ts` — Claude Code 系统提示词注入、Tool 名称前缀处理(`mcp_`)、Prompt 缓存标记、幂等设计

### 关键设计决策

- **被动 Token 刷新**: 仅在 401 时刷新，不预刷新
- **会话 ID**: 基于消息数量 + 内容 hash 生成，用于并发控制
- **模型映射**: `storage.ts` 中维护 13 种默认映射(GPT→Claude)，支持配置覆盖
- **幂等处理**: `request-processor.ts` 通过标记避免重复注入系统提示词
- **Handler 工厂模式**: 每个 handler 导出 `createXxxHandler()` 工厂函数

## API 参数兼容性说明

### 已映射参数（通过变通实现，行为与 OpenAI 有差异）

| 参数 | API | 变通方式 |
|------|-----|---------|
| `reasoning_effort` | Chat Completions | → Anthropic `thinking.budgetTokens`（low=4096, medium=10000, high=20000） |
| `reasoning.effort` | Responses API | → Anthropic `thinking.budgetTokens`（minimal=2048, low=4096, medium=10000, high=20000） |
| `response_format.json_object` | Chat Completions | → system prompt 注入 JSON 指令，不保证严格 JSON 输出 |
| `response_format.json_schema` | Chat Completions | → 将 schema 注入 system prompt，无结构化输出保证 |
| `stream_options.include_usage` | Chat Completions | → 在 `[DONE]` 前发送 OpenAI 格式的 usage SSE chunk |
| `messages[].role="developer"` | Chat Completions | → 等同于 system role，提取为 system prompt |

### 已忽略参数（接受但不产生效果）

以下参数被接受以保持 API 兼容性，但 Anthropic API 无对应功能，不会产生效果也不会报错：

**Chat Completions:** `n`, `seed`, `logprobs`, `top_logprobs`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `web_search_options`, `prediction`, `store`, `service_tier`, `user`

**Responses API:** `reasoning.summary`, `store`, `include`, `context_management`, `text.format`（非 json_object 类型）

## Behavioral Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER save working files or tests to the root folder
- ALWAYS read a file before editing it
- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing

## File Organization

- `/src` — 源代码
- `/tests` — 测试文件
- `/docs` — 文档
- `/config` — 配置文件
- `/scripts` — 工具脚本

## Workflow Rules（Skills & claude-flow MCP）

所有操作必须通过 Skills 和 claude-flow MCP 工具进行协调：

- 复杂任务 → 使用 Skills（如 `/sparc`, `/claude-flow-swarm`, `/hooks-automation`）
- 多 agent 协作 → 通过 claude-flow MCP 工具初始化 swarm
- 记忆与上下文 → 通过 `mcp__claude-flow__memory_*` 存储和检索
- 任务编排 → 通过 `mcp__claude-flow__task_*` 创建和管理
- Agent 生命周期 → 通过 `mcp__claude-flow__agent_*` 管理

### Swarm 操作规则

- ALWAYS use `run_in_background: true` for agent Task calls
- ALL agent Task calls in ONE message for parallel execution
- After spawning, STOP — do NOT poll status, trust agents to return
- Use hierarchical topology, maxAgents 6-8, specialized strategy

```bash
# 初始化 swarm
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized

# claude-flow MCP 配置
claude mcp add claude-flow -- npx -y @claude-flow/cli@latest
```

### 3-Tier Model Routing

| Tier | Handler | Use Cases |
|------|---------|-----------|
| **1** | Agent Booster (WASM) | Simple transforms — Skip LLM |
| **2** | Haiku | Low complexity (<30%) |
| **3** | Sonnet/Opus | Complex reasoning (>30%) |

## Concurrency

- All operations MUST be concurrent/parallel in a single message
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL Bash commands in ONE message
- ALWAYS spawn ALL agents in ONE message
