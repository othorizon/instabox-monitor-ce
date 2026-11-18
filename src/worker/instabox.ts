// instabox HTTP API 的最小客户端（https://instabox.sh/docs/api-reference/openapi.yaml）

import type { MachineState } from "../shared/types";

const DEFAULT_BASE = "https://api.instabox.sh";

export interface InstaboxMachine {
  id: string;
  name: string;
  state: MachineState;
  desiredState: MachineState;
  runStartedAt: string | null;
  cooldownUntil: string | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export class InstaboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class Instabox {
  private readonly base: string;
  constructor(
    private readonly apiKey: string,
    base?: string,
  ) {
    this.base = (base || DEFAULT_BASE).replace(/\/$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown, idempotent = false): Promise<T> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应
    }
    if (!res.ok) {
      const err = data?.error;
      throw new InstaboxError(err?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, err?.code);
    }
    return data as T;
  }

  getMachine(id: string) {
    return this.call<InstaboxMachine>("GET", `/v1/machines/${encodeURIComponent(id)}`);
  }

  async listMachines(): Promise<InstaboxMachine[]> {
    const all: InstaboxMachine[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const q: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page: { machines: InstaboxMachine[]; nextCursor: string | null } = await this.call("GET", `/v1/machines${q}`);
      all.push(...page.machines);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return all;
  }

  suspend(id: string) {
    return this.call("POST", `/v1/machines/${encodeURIComponent(id)}/suspend`, {}, true);
  }

  resume(id: string) {
    return this.call("POST", `/v1/machines/${encodeURIComponent(id)}/resume`, {}, true);
  }

  start(id: string) {
    return this.call("POST", `/v1/machines/${encodeURIComponent(id)}/start`, {}, true);
  }

  exec(id: string, req: { argv: string[]; stdin?: string; timeoutSeconds?: number; noHistory?: boolean }) {
    return this.call<ExecResult>("POST", `/v1/machines/${encodeURIComponent(id)}/exec`, req);
  }
}
