/**
 * 会话管理器
 * - 防止同一会话的并发请求
 * - 请求去重（防止短时间内的重复请求）
 */

import { createHash } from "crypto";

/** 活跃请求信息 */
interface ActiveRequest {
  /** 请求开始时间 */
  startTime: number;
  /** 请求内容 hash */
  contentHash: string;
  /** 取消函数（用于流式响应） */
  abortController?: AbortController;
}

/** 去重请求信息 */
interface DedupeEntry {
  /** 请求时间 */
  timestamp: number;
  /** 请求是否仍在处理中 */
  inProgress: boolean;
}

/** 会话管理器配置 */
interface SessionManagerConfig {
  /** 去重时间窗口（毫秒），默认 2000ms */
  dedupeWindowMs: number;
  /** 请求超时时间（毫秒），默认 300000ms (5分钟) */
  requestTimeoutMs: number;
  /** 是否启用去重，默认 true */
  enableDedupe: boolean;
  /** 是否启用会话忙碌检测，默认 true */
  enableBusyCheck: boolean;
}

const DEFAULT_CONFIG: SessionManagerConfig = {
  dedupeWindowMs: 2000,
  requestTimeoutMs: 300000,
  enableDedupe: true,
  enableBusyCheck: true,
};

class SessionManager {
  /** 活跃请求映射：sessionId -> ActiveRequest */
  private activeRequests: Map<string, ActiveRequest> = new Map();

  /** 请求去重映射：contentHash -> DedupeEntry */
  private dedupeCache: Map<string, DedupeEntry> = new Map();

  /** 配置 */
  private config: SessionManagerConfig;

  /** 清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SessionManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
  }

  /**
   * 计算请求内容的 hash
   */
  private computeHash(content: any): string {
    const str = typeof content === "string" ? content : JSON.stringify(content);
    return createHash("sha256").update(str).digest("hex").substring(0, 16);
  }

  /**
   * 从请求中提取会话 ID
   * 优先使用消息中的会话标识，否则生成一个基于内容的 ID
   *
   * 注意：对于 Claude Code 的工具调用循环，每次请求的消息数量不同，
   * 但第一条用户消息通常是相同的。我们使用第一条用户消息的 hash
   * 作为会话标识，这样可以正确识别同一对话的不同请求。
   *
   * 但是，我们需要确保工具调用后的请求不会被"会话忙碌"阻止。
   * 因此，我们在会话 ID 中包含消息数量，使每次请求都有唯一的会话 ID。
   * 这样"会话忙碌检测"实际上变成了"防止完全相同请求的并发处理"。
   */
  extractSessionId(body: any): string {
    // 尝试从请求中提取会话 ID
    // 1. 检查是否有明确的 session_id
    if (body.session_id) {
      return body.session_id;
    }

    // 2. 检查 metadata 中是否有会话信息
    if (body.metadata?.session_id) {
      return body.metadata.session_id;
    }

    // 3. 对于 Claude Code 风格的请求，使用消息数组长度 + 第一条消息的 hash
    // 这样可以：
    // - 防止完全相同的请求并发处理
    // - 允许工具调用后的后续请求（消息数量不同）
    if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
      const firstMessage = body.messages[0];
      // 使用消息数量 + 第一条消息的 hash，确保工具调用循环的每个请求有唯一 ID
      const sessionKey = `msg_${body.messages.length}_${this.computeHash(firstMessage)}`;
      return sessionKey;
    }

    // 4. 对于 Responses API，使用 input 数组长度 + 第一个 input 的 hash
    if (body.input && Array.isArray(body.input) && body.input.length > 0) {
      const firstInput = body.input[0];
      return `input_${body.input.length}_${this.computeHash(firstInput)}`;
    }

    // 5. 默认使用整个请求体的 hash
    return `req_${this.computeHash(body)}`;
  }

  /**
   * 检查会话是否忙碌
   */
  isSessionBusy(sessionId: string): boolean {
    if (!this.config.enableBusyCheck) {
      return false;
    }

    const active = this.activeRequests.get(sessionId);
    if (!active) {
      return false;
    }

    // 检查是否超时
    const elapsed = Date.now() - active.startTime;
    if (elapsed > this.config.requestTimeoutMs) {
      // 超时，清理这个请求
      this.activeRequests.delete(sessionId);
      return false;
    }

    return true;
  }

  /**
   * 检查请求是否重复（在去重时间窗口内）
   */
  isDuplicateRequest(body: any): boolean {
    if (!this.config.enableDedupe) {
      return false;
    }

    const contentHash = this.computeHash(body);
    const entry = this.dedupeCache.get(contentHash);

    if (!entry) {
      return false;
    }

    const elapsed = Date.now() - entry.timestamp;

    // 如果在时间窗口内，且请求仍在处理中，认为是重复请求
    if (elapsed < this.config.dedupeWindowMs && entry.inProgress) {
      console.log(
        `[session-manager] Duplicate request detected (hash: ${contentHash}, elapsed: ${elapsed}ms)`
      );
      return true;
    }

    return false;
  }

  /**
   * 开始跟踪请求
   * @returns 如果请求被接受返回 true，如果应该拒绝返回 false
   */
  startRequest(
    sessionId: string,
    body: any,
    abortController?: AbortController
  ): { accepted: boolean; reason?: string } {
    // 检查会话是否忙碌
    if (this.isSessionBusy(sessionId)) {
      return {
        accepted: false,
        reason: `Session ${sessionId} is busy processing another request`,
      };
    }

    // 检查是否重复请求
    if (this.isDuplicateRequest(body)) {
      return {
        accepted: false,
        reason: "Duplicate request detected within dedupe window",
      };
    }

    const contentHash = this.computeHash(body);
    const now = Date.now();

    // 记录活跃请求
    this.activeRequests.set(sessionId, {
      startTime: now,
      contentHash,
      abortController,
    });

    // 记录去重信息
    this.dedupeCache.set(contentHash, {
      timestamp: now,
      inProgress: true,
    });

    console.log(
      `[session-manager] Request started (session: ${sessionId}, hash: ${contentHash})`
    );

    return { accepted: true };
  }

  /**
   * 结束请求跟踪
   */
  endRequest(sessionId: string): void {
    const active = this.activeRequests.get(sessionId);
    if (active) {
      // 更新去重缓存
      const entry = this.dedupeCache.get(active.contentHash);
      if (entry) {
        entry.inProgress = false;
      }

      // 移除活跃请求
      this.activeRequests.delete(sessionId);

      const duration = Date.now() - active.startTime;
      console.log(
        `[session-manager] Request ended (session: ${sessionId}, duration: ${duration}ms)`
      );
    }
  }

  /**
   * 取消会话中的请求
   */
  cancelRequest(sessionId: string): boolean {
    const active = this.activeRequests.get(sessionId);
    if (active?.abortController) {
      active.abortController.abort();
      this.endRequest(sessionId);
      console.log(`[session-manager] Request cancelled (session: ${sessionId})`);
      return true;
    }
    return false;
  }

  /**
   * 获取活跃会话数量
   */
  getActiveSessionCount(): number {
    return this.activeRequests.size;
  }

  /**
   * 获取所有活跃会话 ID
   */
  getActiveSessions(): string[] {
    return Array.from(this.activeRequests.keys());
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    // 每 30 秒清理一次过期的去重缓存
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 30000);
  }

  /**
   * 清理过期数据
   */
  private cleanup(): void {
    const now = Date.now();

    // 清理过期的去重缓存（保留 1 分钟内的记录）
    for (const [hash, entry] of this.dedupeCache.entries()) {
      if (now - entry.timestamp > 60000) {
        this.dedupeCache.delete(hash);
      }
    }

    // 清理超时的活跃请求
    for (const [sessionId, active] of this.activeRequests.entries()) {
      if (now - active.startTime > this.config.requestTimeoutMs) {
        console.log(
          `[session-manager] Cleaning up timed out request (session: ${sessionId})`
        );
        this.activeRequests.delete(sessionId);
      }
    }
  }

  /**
   * 停止会话管理器
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// 导出单例实例
export const sessionManager = new SessionManager();

// 导出类型和类（用于测试或自定义实例）
export { SessionManager, SessionManagerConfig, ActiveRequest };
