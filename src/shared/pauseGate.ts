// 定时暂停的“还不能暂停”判断，Cron 和页面共用。
//
// 按顺序检查，命中第一条就不暂停（这一轮继续等，下一次检查再看）：
//   1. 检测失败：按有任务处理，由最长等待时间兜底
//   2. 有运行中的任务
//   3. 有等你回复的任务，且设置为“继续等”
//   4. 等你回复按空闲处理，但有任务开始等你还不满 waitingUserGraceMinutes
//   5. 最后一个任务结束还不满 quietAfterEndMinutes
// 4、5 是“至少”：每次检查时判断，满足后的下一次检查才暂停，不会为此加检查。

import type { ProbeResult, ProbeThread, ScheduleConfig } from "./types";

export type PauseBlocker =
  | { kind: "probe_failed" }
  | { kind: "running" }
  | { kind: "waiting_user" }
  /** 等你回复还不满宽限时间；until：最早可以暂停的时间 */
  | { kind: "waiting_user_recent"; thread: ProbeThread; since: number; until: number }
  /** 任务刚结束；until：最早可以暂停的时间 */
  | { kind: "just_ended"; endedAt: number; until: number };

type GateConfig = Pick<ScheduleConfig, "waitingUserCountsAsBusy" | "quietAfterEndMinutes" | "waitingUserGraceMinutes">;

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function pauseBlocker(probe: ProbeResult, config: GateConfig, now: number): PauseBlocker | null {
  if (!probe.ok) return { kind: "probe_failed" };
  if (probe.running > 0) return { kind: "running" };
  if (probe.waitingUser > 0 && config.waitingUserCountsAsBusy) return { kind: "waiting_user" };

  const grace = config.waitingUserGraceMinutes * 60_000;
  if (grace > 0) {
    // 取最晚开始等你的那个：它满了，其他的也都满了
    let latest: { thread: ProbeThread; since: number } | null = null;
    for (const t of probe.threads) {
      if (t.state !== "waiting_user") continue;
      const since = parseTs(t.waitingSince);
      if (since !== null && (!latest || since > latest.since)) latest = { thread: t, since };
    }
    if (latest && now < latest.since + grace) return { kind: "waiting_user_recent", ...latest, until: latest.since + grace };
  }

  const quiet = config.quietAfterEndMinutes * 60_000;
  const endedAt = parseTs(probe.lastEndedAt);
  if (quiet > 0 && endedAt !== null && now < endedAt + quiet) return { kind: "just_ended", endedAt, until: endedAt + quiet };

  return null;
}

export function pendingLabel(kind: string | null | undefined): string {
  // 已见过的值：approval_request、user_input / user_input_request
  return kind?.includes("approval") ? "等你批准" : "等你回答";
}
