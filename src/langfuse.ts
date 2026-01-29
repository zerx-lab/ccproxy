/**
 * Langfuse Tracing 模块
 * 提供 LLM 调用的可观测性追踪
 */

import { Langfuse } from "langfuse";

// 从环境变量读取配置
const TRACE_TO_LANGFUSE = process.env.TRACE_TO_LANGFUSE === "true";
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
const LANGFUSE_HOST = process.env.LANGFUSE_HOST || "https://cloud.langfuse.com";

// Langfuse 客户端实例
let langfuseClient: Langfuse | null = null;

/**
 * 检查是否启用了 Langfuse tracing
 */
export function isLangfuseEnabled(): boolean {
  return TRACE_TO_LANGFUSE && !!LANGFUSE_PUBLIC_KEY && !!LANGFUSE_SECRET_KEY;
}

/**
 * 获取 Langfuse 客户端实例（单例模式）
 */
export function getLangfuse(): Langfuse | null {
  if (!isLangfuseEnabled()) {
    return null;
  }

  if (!langfuseClient) {
    langfuseClient = new Langfuse({
      publicKey: LANGFUSE_PUBLIC_KEY!,
      secretKey: LANGFUSE_SECRET_KEY!,
      baseUrl: LANGFUSE_HOST,
    });
    console.log(`[Langfuse] Initialized with host: ${LANGFUSE_HOST}`);
  }

  return langfuseClient;
}

/**
 * 创建一个新的 trace
 */
export function createTrace(params: {
  name: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  input?: any;
}) {
  const langfuse = getLangfuse();
  if (!langfuse) {
    return null;
  }

  return langfuse.trace({
    name: params.name,
    userId: params.userId,
    sessionId: params.sessionId,
    metadata: params.metadata,
    input: params.input,
  });
}

// Generation 返回类型
type LangfuseGeneration = ReturnType<ReturnType<Langfuse["trace"]>["generation"]>;

/**
 * 更新 trace（用于在请求解析后设置 input/output）
 */
export function updateTrace(
  trace: ReturnType<Langfuse["trace"]>,
  params: {
    input?: any;
    output?: any;
    metadata?: Record<string, any>;
    userId?: string;
    sessionId?: string;
  }
) {
  trace.update({
    input: params.input,
    output: params.output,
    metadata: params.metadata,
    userId: params.userId,
    sessionId: params.sessionId,
  });
}

/**
 * 创建 generation（用于 LLM 调用追踪）
 */
export interface GenerationParams {
  trace: ReturnType<Langfuse["trace"]>;
  name: string;
  model: string;
  input: any;
  metadata?: Record<string, any>;
}

export function createGeneration(params: GenerationParams): LangfuseGeneration {
  return params.trace.generation({
    name: params.name,
    model: params.model,
    input: params.input,
    metadata: params.metadata,
  });
}

/**
 * 结束 generation 并记录输出
 */
export interface EndGenerationParams {
  generation: LangfuseGeneration;
  output: any;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
}

export function endGeneration(params: EndGenerationParams) {
  // 使用 update() 更新输出和 usageDetails，然后调用 end()
  // Langfuse 推荐使用 usageDetails 字段，格式为 { input: number, output: number, total?: number }
  const updateParams: any = {
    output: params.output,
    level: params.level,
    statusMessage: params.statusMessage,
  };

  if (params.usage) {
    // 使用 usageDetails（新格式）- 使用 input/output 而不是 promptTokens/completionTokens
    updateParams.usageDetails = {
      input: params.usage.promptTokens || 0,
      output: params.usage.completionTokens || 0,
      total: params.usage.totalTokens || 0,
    };
    // 同时也设置 usage（兼容旧格式）
    updateParams.usage = {
      promptTokens: params.usage.promptTokens,
      completionTokens: params.usage.completionTokens,
      totalTokens: params.usage.totalTokens,
    };
  }

  params.generation.update(updateParams);
  params.generation.end();
}

/**
 * 关闭 Langfuse 客户端（确保所有数据都已发送）
 */
export async function shutdownLangfuse() {
  if (langfuseClient) {
    await langfuseClient.shutdownAsync();
    langfuseClient = null;
    console.log("[Langfuse] Shutdown completed");
  }
}

/**
 * 刷新 Langfuse 客户端（发送所有待处理的数据）
 */
export async function flushLangfuse() {
  if (langfuseClient) {
    await langfuseClient.flushAsync();
  }
}
