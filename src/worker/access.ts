// 校验 Cloudflare Access 签发的 JWT（防止绕过 Access 直接请求 Worker）

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./db";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type AccessResult = { ok: true; email: string } | { ok: false; status: number; error: string };

export async function verifyAccess(req: Request, env: Env): Promise<AccessResult> {
  if (env.DEV_SKIP_ACCESS === "1") return { ok: true, email: "dev@localhost" };

  const team = env.ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!team || !env.ACCESS_AUD) {
    return { ok: false, status: 500, error: "未配置 ACCESS_TEAM_DOMAIN / ACCESS_AUD，拒绝访问" };
  }
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, error: "缺少 Cloudflare Access 凭证" };

  const issuer = `https://${team}`;
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    const allowed = (env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(email)) {
      return { ok: false, status: 403, error: "该账户无权访问" };
    }
    return { ok: true, email };
  } catch {
    return { ok: false, status: 401, error: "Cloudflare Access 凭证无效" };
  }
}
