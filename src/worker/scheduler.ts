// 定时暂停状态机（纯函数，便于测试）。
//
// Cron 每分钟跑一次，对每台机器：
//   1. planTick：根据当前周期、执行记录和机器状态，决定这一分钟要做什么
//   2. 若需要检测 t3，执行探测后用 resolveCheck 决定暂停 / 继续等 / 超时处理
//
// “跳过”只针对单次检查：有任务时本轮不暂停，5 分钟后再查，直到任务结束或到达最大等待时间。

import type { MachineLive, NightlyRun, ScheduleConfig, SkipInfo } from "../shared/types";
import { currentCycle, todayAt, type Cycle } from "./time";

export const CHECK_INTERVAL_MS = 5 * 60_000;
/** 关闭“等待 t3”时，暂停时间点之后多久内仍会补做暂停（例如刚部署或 Cron 故障恢复） */
export const NO_WAIT_GRACE_MS = 60 * 60_000;
/** 到达截止时间后暂停仍失败，再重试多久就放弃 */
export const PAUSE_RETRY_GRACE_MS = 60 * 60_000;

export type TickPlan =
  | { kind: "idle" }
  /** 机器已经不在运行（已暂停/停止），无需操作 */
  | { kind: "already_paused"; create: boolean }
  /** 不等待 t3，直接暂停（create：先前没有记录） */
  | { kind: "pause_now"; create: boolean }
  /** 需要探测 t3（create：先创建 waiting 记录） */
  | { kind: "check"; create: boolean }
  /** 配置关闭了定时暂停，结束正在等待的记录 */
  | { kind: "cancel" }
  /** 截止后长时间暂停失败，结束记录 */
  | { kind: "give_up_error" };

const PAUSED_STATES = new Set(["suspending", "suspended", "stopping", "stopped"]);

export function planTick(input: {
  now: number;
  config: ScheduleConfig;
  cycle: Cycle;
  run: NightlyRun | null;
  live: MachineLive;
}): TickPlan {
  const { now, config, cycle, run, live } = input;

  if (run?.status === "done") return { kind: "idle" };

  if (run?.status === "waiting") {
    if (!config.enabled) return { kind: "cancel" };
    if (PAUSED_STATES.has(live.state)) return { kind: "already_paused", create: false };
    if (live.state !== "running") return { kind: "idle" }; // 启动中/未知：下一分钟再看
    if (now >= run.deadlineAt + PAUSE_RETRY_GRACE_MS) return { kind: "give_up_error" };
    // 等待途中关闭了“等待 t3”：立即暂停
    if (!config.waitForT3) return { kind: "pause_now", create: false };
    const due = run.lastCheckAt === null || now - run.lastCheckAt >= CHECK_INTERVAL_MS || now >= run.deadlineAt;
    return due ? { kind: "check", create: false } : { kind: "idle" };
  }

  // 本周期还没有记录
  if (!config.enabled) return { kind: "idle" };
  const window = config.waitForT3 ? config.maxWaitMinutes * 60_000 : NO_WAIT_GRACE_MS;
  if (now < cycle.startAt || now >= cycle.startAt + window) return { kind: "idle" };
  if (PAUSED_STATES.has(live.state)) return { kind: "already_paused", create: true };
  if (live.state !== "running") return { kind: "idle" };
  return config.waitForT3 ? { kind: "check", create: true } : { kind: "pause_now", create: true };
}

export type CheckOutcome = "pause" | "force" | "give_up" | "wait";

export function resolveCheck(input: { now: number; deadlineAt: number; busy: boolean; onTimeout: ScheduleConfig["onTimeout"] }): CheckOutcome {
  if (!input.busy) return "pause";
  if (input.now >= input.deadlineAt) return input.onTimeout === "force" ? "force" : "give_up";
  return "wait";
}

export function deadlineFor(cycle: Cycle, config: ScheduleConfig): number {
  return cycle.startAt + (config.waitForT3 ? config.maxWaitMinutes * 60_000 : NO_WAIT_GRACE_MS);
}

export { currentCycle };

/**
 * 定时唤醒只在唤醒时间点之后的这几分钟内触发，用来容忍 Cron 的抖动；
 * 错过就不补（例如刚部署、Cron 故障）。
 */
export const WAKE_TRIGGER_WINDOW_MS = 5 * 60_000;

/**
 * 这一分钟是否处在定时唤醒的触发窗口内；是则返回当天日期（每天只唤醒一次的去重 key），否则 null。
 * 去重由调用方在数据库里原子完成。
 */
export function planWake(now: number, config: ScheduleConfig): string | null {
  if (!config.wakeEnabled || !config.wakeDays.length) return null;
  const today = todayAt(now, config.wakeTime, config.timezone);
  if (!config.wakeDays.includes(today.weekday)) return null;
  if (now < today.at || now >= today.at + WAKE_TRIGGER_WINDOW_MS) return null;
  return today.date;
}

/**
 * “跳过这次”的状态。
 * - 下一次暂停已被跳过 → 显示它，直到它的时间点过去
 * - 当前这次（已到点）被跳过、仍在等待窗口内 → 显示它（撤销后会重新开始等待）
 * - 否则可以跳过：正在等待时跳过当前这次，其余情况跳过下一次
 */
export function skipState(input: {
  now: number;
  config: ScheduleConfig;
  cur: Cycle;
  next: Cycle;
  afterNext: number;
  runCur: NightlyRun | null;
  runNext: NightlyRun | null;
}): { skip: SkipInfo | null; target: SkipInfo | null } {
  const { now, config, cur, next, afterNext, runCur, runNext } = input;
  if (!config.enabled) return { skip: null, target: null };
  const curInfo = (waiting: boolean): SkipInfo => ({ cycleDate: cur.cycleDate, at: cur.startAt, resumeAt: next.startAt, waiting });
  const nextInfo: SkipInfo = { cycleDate: next.cycleDate, at: next.startAt, resumeAt: afterNext, waiting: false };

  if (runNext?.result === "skipped") return { skip: nextInfo, target: null };
  const inWindow = now >= cur.startAt && now < deadlineFor(cur, config);
  if (runCur?.result === "skipped" && inWindow) return { skip: curInfo(false), target: null };
  if (runCur?.status === "waiting") return { skip: null, target: curInfo(true) };
  // 已到点、仍在窗口内但还没有记录（Cron 下一分钟才会开始处理）：跳过的也是当前这次
  if (!runCur && inWindow) return { skip: null, target: curInfo(false) };
  return { skip: null, target: nextInfo };
}
