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
