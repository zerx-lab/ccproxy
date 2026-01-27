import { generatePKCE } from "@openauthjs/openauth/pkce";
import { saveAuth, loadAuth, type AuthData } from "./storage";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface AuthorizeResult {
  url: string;
  verifier: string;
}

export interface ExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
}

export interface ExchangeFailed {
  type: "failed";
}

export type ExchangeResult = ExchangeSuccess | ExchangeFailed;

interface OAuthTokenResponse {
  refresh_token: string;
  access_token: string;
  expires_in: number;
}

/**
 * 生成 OAuth 授权 URL
 * @param mode "max" 使用 claude.ai, "console" 使用 console.anthropic.com
 */
export async function authorize(
  mode: "max" | "console" = "max"
): Promise<AuthorizeResult> {
  const pkce = await generatePKCE();

  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback"
  );
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);

  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

/**
 * 使用授权码交换 token
 */
export async function exchange(
  code: string,
  verifier: string
): Promise<ExchangeResult> {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });

  if (!result.ok) {
    return { type: "failed" };
  }

  const json = await result.json() as OAuthTokenResponse;
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/**
 * 刷新 access token
 */
export async function refreshToken(refreshToken: string): Promise<ExchangeResult> {
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    return { type: "failed" };
  }

  const json = await response.json() as OAuthTokenResponse;
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/**
 * 获取有效的 access token，如果过期则自动刷新
 */
export async function getValidAccessToken(): Promise<string | null> {
  const auth = await loadAuth();
  if (!auth) {
    return null;
  }

  // 如果 token 还有效（提前 5 分钟刷新）
  if (auth.expires > Date.now() + 5 * 60 * 1000) {
    return auth.access;
  }

  // 需要刷新 token
  const result = await refreshToken(auth.refresh);
  if (result.type === "failed") {
    return null;
  }

  // 保存新的 token
  const newAuth: AuthData = {
    type: "oauth",
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
  };
  await saveAuth(newAuth);

  return result.access;
}
