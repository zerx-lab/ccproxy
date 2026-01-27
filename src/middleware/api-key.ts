/**
 * API Key 验证中间件
 */

import type { Context, Next } from "hono";
import { validateApiKey } from "../storage";

/**
 * 创建 API Key 验证中间件
 * @param requireApiKey - 是否需要 API Key 验证
 */
export function createApiKeyMiddleware(requireApiKey: boolean) {
  return async (c: Context, next: Next) => {
    // 如果没有配置 API Key，跳过验证
    if (!requireApiKey) {
      return next();
    }

    // 从请求头获取 API Key
    const authHeader = c.req.header("authorization");
    const xApiKey = c.req.header("x-api-key");

    let providedKey: string | null = null;

    if (authHeader) {
      // 支持 "Bearer sk-xxx" 格式
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) {
        providedKey = match[1] ?? null;
      }
    }

    if (!providedKey && xApiKey) {
      providedKey = xApiKey;
    }

    if (!providedKey) {
      return c.json(
        {
          error: {
            message:
              "Missing API key. Provide it via 'Authorization: Bearer sk-xxx' or 'x-api-key' header.",
            type: "authentication_error",
            code: "missing_api_key",
          },
        },
        401
      );
    }

    const isValid = await validateApiKey(providedKey);
    if (!isValid) {
      return c.json(
        {
          error: {
            message: "Invalid API key.",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        },
        401
      );
    }

    return next();
  };
}


