# CCProxy

Claude Code 订阅代理服务器 - 使用 Claude Pro/Max 订阅通过 API 访问 Claude 模型。

## 功能特性

- OAuth 认证 - 使用 Claude Pro/Max 订阅登录
- 自动 Token 刷新 - 过期前自动刷新 access token
- OpenAI Chat Completions API - 支持 `/v1/chat/completions` 端点
- OpenAI Responses API - 支持 `/v1/responses` 端点 (最新)
- Anthropic 原生 API - 支持 `/v1/messages` 端点
- 流式响应 (SSE) - 支持实时流式输出
- 模型映射 - 可配置的模型名称映射

## 安装

```bash
bun install
```

## 快速开始

### 1. 登录

```bash
bun run src/cli.ts login
```

登录流程：
1. 打开浏览器访问显示的 OAuth URL
2. 授权后复制授权码
3. 粘贴授权码完成登录

凭证保存在 `~/.ccproxy/auth.json`

### 2. 启动服务器

```bash
bun run src/cli.ts start
```

可选参数：
- `-p, --port <port>` - 监听端口 (默认: 3456)
- `-h, --host <host>` - 绑定地址 (默认: 127.0.0.1)

```bash
# 示例：在 8080 端口启动
bun run src/cli.ts start -p 8080
```

## CLI 命令

```bash
# 登录
ccproxy login

# 启动服务器
ccproxy start [--port 3456] [--host 127.0.0.1]

# 查看认证状态
ccproxy status

# 登出
ccproxy logout

# 配置管理
ccproxy config show              # 查看当前配置
ccproxy config reset             # 重置为默认配置
ccproxy config set-model <from> <to>  # 添加/更新模型映射
ccproxy config remove-model <name>    # 删除模型映射
ccproxy config path              # 显示配置文件路径
```

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI Chat Completions API |
| `/v1/responses` | POST | OpenAI Responses API (最新) |
| `/v1/messages` | POST | Anthropic 原生格式 |
| `/v1/models` | GET | 列出可用模型 |
| `/health` | GET | 健康检查 |

## 配置文件

配置文件位于 `~/.ccproxy/config.json`

```json
{
  "modelMapping": {
    "gpt-4": "claude-sonnet-4-20250514",
    "gpt-4-turbo": "claude-sonnet-4-20250514",
    "gpt-4o": "claude-sonnet-4-20250514",
    "gpt-4o-mini": "claude-3-5-haiku-20241022",
    "gpt-3.5-turbo": "claude-3-5-haiku-20241022",
    "claude-3-sonnet": "claude-sonnet-4-20250514",
    "claude-3-opus": "claude-opus-4-20250514",
    "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
    "claude-3.5-haiku": "claude-3-5-haiku-20241022",
    "claude-4-sonnet": "claude-sonnet-4-20250514",
    "claude-4-opus": "claude-opus-4-20250514",
    "sonnet": "claude-sonnet-4-20250514",
    "opus": "claude-opus-4-20250514",
    "haiku": "claude-3-5-haiku-20241022"
  },
  "server": {
    "port": 3456,
    "host": "127.0.0.1"
  }
}
```

### 默认模型映射

| 输入模型 | 目标模型 |
|---------|---------|
| `gpt-4` | `claude-sonnet-4-20250514` |
| `gpt-4-turbo` | `claude-sonnet-4-20250514` |
| `gpt-4o` | `claude-sonnet-4-20250514` |
| `gpt-4o-mini` | `claude-3-5-haiku-20241022` |
| `gpt-3.5-turbo` | `claude-3-5-haiku-20241022` |
| `sonnet` | `claude-sonnet-4-20250514` |
| `opus` | `claude-opus-4-20250514` |
| `haiku` | `claude-3-5-haiku-20241022` |

## 在 Cursor 中使用

Cursor 不支持直接设置 Anthropic Base URL，但可以通过 OpenAI 兼容模式使用：

1. 打开 Cursor Settings > Models
2. 开启 **"Override OpenAI Base URL"**
3. 填入 Base URL: `http://127.0.0.1:3456/v1`
4. OpenAI API Key: 随便填一个值（如 `sk-xxx`）
5. 使用模型时选择 `gpt-4`（会自动映射到 Claude）

或者点击 **"+ Add Custom Model"** 添加自定义模型：
- Model Name: `claude-sonnet-4-20250514`
- Provider: OpenAI

## API 使用示例

### OpenAI 兼容格式 (非流式)

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### OpenAI 兼容格式 (流式)

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "gpt-4",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### OpenAI Responses API (非流式)

```bash
curl http://127.0.0.1:3456/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "gpt-4",
    "input": "Hello, how are you?"
  }'
```

### OpenAI Responses API (流式)

```bash
curl http://127.0.0.1:3456/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "gpt-4",
    "input": "Hello, how are you?",
    "stream": true
  }'
```

### OpenAI Responses API (带系统指令)

```bash
curl http://127.0.0.1:3456/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "gpt-4",
    "instructions": "You are a helpful assistant.",
    "input": [
      {"type": "message", "role": "user", "content": "What is 2+2?"}
    ]
  }'
```

### Anthropic 原生格式 (非流式)

```bash
curl http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Anthropic 原生格式 (流式)

```bash
curl http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## API 参数兼容性

CCProxy 尽量将 OpenAI API 参数映射到对应的 Anthropic 参数。以下是详细的兼容性说明。

### Chat Completions (`/v1/chat/completions`)

| 参数 | 支持状态 | 映射方式 |
|------|----------|----------|
| `model` | ✅ 完全支持 | 通过模型名称映射表转换 |
| `messages` | ✅ 完全支持 | 转换为 Anthropic messages 格式 |
| `messages[].role = "system"` | ✅ 完全支持 | 提取为 Anthropic system prompt |
| `messages[].role = "developer"` | ✅ 完全支持 | 等同于 system，提取为 system prompt |
| `messages[].role = "user"` | ✅ 完全支持 | 直接映射 |
| `messages[].role = "assistant"` | ✅ 完全支持 | 直接映射 |
| `messages[].role = "tool"` | ✅ 完全支持 | 转换为 Anthropic tool_result |
| `tools` | ✅ 完全支持 | 转换为 Anthropic tools 格式 |
| `tool_choice` | ✅ 完全支持 | none/auto/required/function 全映射 |
| `stream` | ✅ 完全支持 | SSE 流式响应 |
| `temperature` | ✅ 完全支持 | 直接传递 |
| `top_p` | ✅ 完全支持 | 映射为 Anthropic `topP` |
| `max_tokens` | ✅ 完全支持 | 映射为 Anthropic `maxOutputTokens` |
| `max_completion_tokens` | ✅ 完全支持 | 优先于 `max_tokens` |
| `stop` | ✅ 完全支持 | 映射为 Anthropic `stopSequences` |
| `parallel_tool_calls` | ✅ 完全支持 | 映射为 Anthropic `disableParallelToolUse`（取反） |
| `prompt_cache_key` | ✅ 支持 | 映射为 Anthropic `cacheControl: ephemeral` |
| `reasoning_effort` | ⚡ 映射支持 | low→4096, medium→10000, high→20000 budgetTokens |
| `response_format.type="text"` | ✅ 完全支持 | 无需处理 |
| `response_format.type="json_object"` | ⚠️ 部分支持 | 向 system prompt 注入 JSON 指令，不保证严格 JSON 输出 |
| `response_format.type="json_schema"` | ⚠️ 部分支持 | 将 schema 注入 system prompt，无结构化输出保证 |
| `stream_options.include_usage` | ✅ 支持 | 在 `[DONE]` 前发送 usage SSE chunk |
| `user` | 🔇 忽略 | 接受但不使用（Anthropic 不支持用户ID透传） |
| `n` | 🔇 忽略 | 始终返回 1 条结果 |
| `seed` | 🔇 忽略 | Anthropic 不支持确定性输出 |
| `logprobs` / `top_logprobs` | 🔇 忽略 | Anthropic 不提供 logprobs |
| `presence_penalty` / `frequency_penalty` | 🔇 忽略 | Anthropic 不支持 |
| `logit_bias` | 🔇 忽略 | Anthropic 不支持 |
| `web_search_options` | 🔇 忽略 | Anthropic 不支持原生网络搜索 |
| `prediction` | 🔇 忽略 | Anthropic 不支持预测输出 |
| `store` | 🔇 忽略 | Anthropic 无状态存储 |
| `service_tier` | 🔇 忽略 | OpenAI 基础设施概念 |

### Responses API (`/v1/responses`)

| 参数 | 支持状态 | 映射方式 |
|------|----------|----------|
| `model` | ✅ 完全支持 | 模型名称映射 |
| `input` (string) | ✅ 完全支持 | 转为 user message |
| `input` (array) | ✅ 完全支持 | 支持 message/function_call/function_call_output |
| `input[].role="developer"` | ✅ 完全支持 | 合并到 system prompt |
| `instructions` | ✅ 完全支持 | 作为 system prompt |
| `tools` | ✅ 完全支持 | 转换为 Anthropic tools |
| `tool_choice` | ✅ 完全支持 | 全类型映射 |
| `stream` | ✅ 完全支持 | Responses API SSE 事件格式 |
| `temperature` | ✅ 完全支持 | 直接传递 |
| `top_p` | ✅ 完全支持 | 直接传递 |
| `max_output_tokens` | ✅ 完全支持 | 默认 8192 |
| `parallel_tool_calls` | ✅ 完全支持 | 映射为 `disableParallelToolUse` |
| `metadata` | ✅ 回显 | 原样回显在响应中，不透传给模型 |
| `previous_response_id` | ✅ 回显 | 接受并回显，多轮对话通过 input 数组实现 |
| `truncation` | ✅ 回显 | 接受并回显 |
| `reasoning.effort` | ⚡ 映射支持 | minimal→2048, low→4096, medium→10000, high→20000 budgetTokens |
| `reasoning.summary` | 🔇 忽略 | Anthropic 不支持推理摘要格式 |
| `store` | 🔇 忽略 | Anthropic 无持久存储 |
| `text.format` | ⚠️ 部分支持 | json_object 类型通过 system prompt 注入实现 |
| `include` | 🔇 忽略 | 仅 usage 数据默认包含 |
| `context_management` | 🔇 忽略 | Anthropic 不支持自动上下文管理 |

### Anthropic Messages (`/v1/messages`)

Anthropic 原生格式直接透传，所有 Anthropic API 参数均完全支持：
`model`, `messages`, `system`, `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `stream`, `tools`, `tool_choice`, `metadata`, `thinking`（扩展思考）, `cache_control`

### 图例

- ✅ **完全支持** — 直接映射到 Anthropic 等效参数
- ⚡ **映射支持** — 通过近似映射实现，语义基本一致
- ⚠️ **部分支持** — 通过变通方式实现，行为可能与 OpenAI 有差异
- 🔇 **忽略** — 参数被接受但不产生效果（不会报错）

## 文件结构

```
ccproxy/
├── src/
│   ├── auth.ts      # OAuth 认证模块
│   ├── storage.ts   # 凭证和配置存储
│   ├── server.ts    # API 代理服务器
│   └── cli.ts       # CLI 入口
├── index.ts         # 模块导出
├── package.json
└── README.md
```

## 依赖

- [Bun](https://bun.sh) - JavaScript 运行时
- [Hono](https://hono.dev) - Web 框架
- [AI SDK](https://sdk.vercel.ai) - AI 模型集成
- [Commander](https://github.com/tj/commander.js) - CLI 框架
- [@openauthjs/openauth](https://github.com/openauthjs/openauth) - OAuth PKCE

## License

MIT
