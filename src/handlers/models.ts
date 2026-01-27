/**
 * Models API 端点处理器
 * GET /v1/models
 */

import type { Context } from "hono";

/** 可用的模型列表 */
const AVAILABLE_MODELS = [
  {
    id: "claude-sonnet-4-20250514",
    object: "model",
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-20250514",
    object: "model",
    owned_by: "anthropic",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    object: "model",
    owned_by: "anthropic",
  },
  {
    id: "claude-3-5-haiku-20241022",
    object: "model",
    owned_by: "anthropic",
  },
  {
    id: "claude-3-opus-20240229",
    object: "model",
    owned_by: "anthropic",
  },
];

/**
 * 处理 Models 列表请求
 */
export function handleModels(c: Context) {
  return c.json({
    object: "list",
    data: AVAILABLE_MODELS,
  });
}

/**
 * 获取可用模型列表
 */
export function getAvailableModels() {
  return AVAILABLE_MODELS;
}
