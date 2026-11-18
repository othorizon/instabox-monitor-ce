// 暂停 / 唤醒：页面按钮和定时任务共用

import { Instabox, InstaboxError, type InstaboxMachine } from "./instabox";
import { finishRun, getWaitingRun, logEvent, recordAction, type Env } from "./db";
import type { ActivityEvent } from "../shared/types";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function api(env: Env) {
  if (!env.INSTABOX_API_KEY) throw new ActionError("未配置 INSTABOX_API_KEY", 500);
  return new Instabox(env.INSTABOX_API_KEY, env.INSTABOX_API_URL);
}

function describe(e: unknown): string {
  if (e instanceof InstaboxError) return e.code ? `${e.message}（${e.code}）` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** 暂停机器并记录活动。用户手动暂停时，结束当晚正在等待的定时暂停。 */
export async function pauseMachine(
  env: Env,
  machineId: string,
  opts: { source: ActivityEvent["source"]; type: string; message: string; detail?: unknown },
) {
  const now = Date.now();
  try {
    await api(env).suspend(machineId);
  } catch (e) {
    const msg = describe(e);
    await logEvent(env.DB, { machineId, type: "error", source: opts.source, message: `暂停失败：${msg}` });
    throw new ActionError(`暂停失败：${msg}`, 502);
  }
  await recordAction(env.DB, machineId, "suspended", now);
  await logEvent(env.DB, { machineId, type: opts.type, source: opts.source, message: opts.message, detail: opts.detail });
  if (opts.source === "user") {
    const waiting = await getWaitingRun(env.DB, machineId);
    if (waiting) {
      await finishRun(env.DB, machineId, waiting.cycleDate, "manual", now);
    }
  }
}

export async function wakeMachine(env: Env, machineId: string) {
  const ib = api(env);
  let m: InstaboxMachine;
  try {
    m = await ib.getMachine(machineId);
  } catch (e) {
    throw new ActionError(`读取机器状态失败：${describe(e)}`, 502);
  }
  if (m.cooldownUntil && Date.parse(m.cooldownUntil) > Date.now()) {
    throw new ActionError("机器处于 instabox 冷却期，暂时不能唤醒", 409);
  }
  try {
    if (m.state === "suspended") await ib.resume(machineId);
    else if (m.state === "stopped") await ib.start(machineId);
    else throw new ActionError(`机器当前是 ${m.state} 状态，无需唤醒`, 409);
  } catch (e) {
    if (e instanceof ActionError) throw e;
    const msg = describe(e);
    await logEvent(env.DB, { machineId, type: "error", source: "user", message: `唤醒失败：${msg}` });
    throw new ActionError(`唤醒失败：${msg}`, 502);
  }
  await recordAction(env.DB, machineId, "running", Date.now());
  await logEvent(env.DB, { machineId, type: "manual_wake", source: "user", message: m.state === "stopped" ? "手动启动" : "手动唤醒" });
}

export { describe as describeError };
