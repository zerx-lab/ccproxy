/**
 * CCProxy 类型定义模块
 * 集中管理所有接口和类型定义
 */

// ============ 代理服务器选项 ============
export interface ProxyOptions {
  port: number;
  host: string;
}

// ============ 日志相关类型 ============
export interface LogEntry {
  timestamp: string;
  type: "request" | "response" | "error";
  endpoint: string;
  method: string;
  data: any;
}

// ============ OpenAI Responses API 类型 ============
export interface ResponsesAPIRequest {
  model: string;
  input?: string | ResponseInputItem[];
  instructions?: string;
  tools?: ResponseTool[];
  tool_choice?: "none" | "auto" | "required";
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  metadata?: Record<string, string>;
  previous_response_id?: string;
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high";
    summary?: "auto" | "concise" | "detailed";
  };
  truncation?: "auto" | "disabled";
  parallel_tool_calls?: boolean;
  // 缓存相关参数
  prompt_cache_key?: string;
  // 状态存储（OpenAI 特有，当前不完全支持）
  store?: boolean;
  // 服务层级（OpenAI 特有，会被忽略）
  service_tier?: string;
}

export interface ResponseInputItem {
  type: "message" | "function_call_output" | "function_call";
  role?: "user" | "assistant" | "system" | "developer";
  content?: string | ResponseContentPart[];
  // function_call_output 类型的字段
  call_id?: string;
  output?: string;
  // function_call 类型的字段
  id?: string;
  name?: string;
  arguments?: string;
}

export interface ResponseContentPart {
  type: "input_text" | "input_image" | "input_file";
  text?: string;
  image_url?: string;
  file_id?: string;
}

export interface ResponseTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, any>;
  strict?: boolean;
}

export interface ResponseOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  content: ResponseOutputContent[];
  status: "in_progress" | "completed" | "incomplete";
}

export interface ResponseOutputFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

export type ResponseOutputItem = ResponseOutputMessage | ResponseOutputFunctionCall;

export interface ResponseOutputContent {
  type: "output_text";
  text: string;
  annotations?: any[];
}

export interface ResponsesAPIResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress" | "cancelled" | "incomplete";
  model: string;
  output: ResponseOutputItem[];
  output_text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  };
  error?: { code: string; message: string } | null;
  incomplete_details?: { reason: string } | null;
  instructions?: string | null;
  metadata?: Record<string, string>;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: ResponseTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  truncation?: string;
  previous_response_id?: string | null;
  reasoning?: any;
}

// ============ OpenAI Chat Completions 类型 ============
export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  tools?: OpenAITool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  parallel_tool_calls?: boolean;
  // 缓存相关参数（OpenAI 特有，会映射到 Anthropic cacheControl）
  prompt_cache_key?: string;
  // 预测输出参数（OpenAI 特有，Anthropic 不支持，会被忽略）
  prediction?: {
    type: "content";
    content: string;
  };
  [key: string]: any;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatMessageContent[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatMessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionsResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "tool_calls" | "length" | null;
}

export interface ChatCompletionsChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatChunkChoice[];
}

export interface ChatChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    tool_calls?: Partial<ToolCall>[];
  };
  finish_reason: "stop" | "tool_calls" | "length" | null;
}
