// 每分钟执行一次：观察机器状态变化，触发定时唤醒，推进定时暂停状态机

import {
  claimWakeRun,
  createRun,
  finishRun,
  getConfig,
  getRun,
  getWaitingRun,
  listMachines,
  logEvent,
  pruneOld,
  recordAction,
  saveProbe,
  setLastError,
  setObservedState,
  setWakeResult,
  touchRun,
  type Env,
  type MachineRow,
} from "./db";
import { api, describeError, pauseMachine } from "./actions";
import { InstaboxError } from "./instabox";
import { currentCycle, deadlineFor, planTick, planWake, resolveCheck } from "./scheduler";
import { probeT3 } from "./t3probe";
import { STATE_LABEL, formatDuration, hhmm, shortTitle } from "../shared/labels";
import { pauseBlocker, pendingLabel, type PauseBlocker } from "../shared/pauseGate";
import type { MachineLive, MachineState, ProbeResult, ScheduleConfig, WakeResult } from "../shared/types";

/** 只在这些“稳定”状态之间记录外部变化，过渡态（暂停中、唤醒中…）不记 */
const STABLE = new Set(["running", "suspended", "stopped", "error", "deleted"]);
/** 本服务操作后这段时间内到达目标状态，视为自己触发的，不再记一条“外部变化” */
const OWN_ACTION_WINDOW_MS = 10 * 60_000;

export async function runCron(env: Env, now = Date.now()) {
  const machines = await listMachines(env.DB);
  const results = await Promise.allSettled(machines.map((m) => tickMachine(env, m, now)));
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") console.error("tick failed", machines[i]?.id, r.reason);
  }
  if (new Date(now).getUTCMinutes() === 0) await pruneOld(env.DB, now);
}

export async function fetchLive(env: Env, machineId: string): Promise<MachineLive> {
  try {
    const m = await api(env).getMachine(machineId);
    return { state: m.state, runStartedAt: m.runStartedAt, cooldownUntil: m.cooldownUntil };
  } catch (e) {
    if (e instanceof InstaboxError && e.status === 404) return { state: "deleted", error: "instabox 上找不到这台机器" };
    return { state: "unknown", error: describeError(e) };
  }
}

function probeSummary(p: ProbeResult): string {
  if (!p.ok) return `检测失败（${p.error}）`;
  const parts: string[] = [];
  if (p.running) parts.push(`${p.running} 个运行中`);
  if (p.waitingUser) parts.push(`${p.waitingUser} 个等你回复`);
  return parts.length ? parts.join("、") : "没有进行中的任务";
}

/** 为什么这一轮不暂停 */
function blockerText(b: PauseBlocker, probe: ProbeResult, config: ScheduleConfig): string {
  const tz = config.timezone;
  switch (b.kind) {
    case "just_ended":
      return `t3 任务 ${hhmm(b.endedAt, tz)} 刚结束，满 ${config.quietAfterEndMinutes} 分钟（${hhmm(b.until, tz)}）后再暂停`;
    case "waiting_user_recent":
      return `“${shortTitle(b.thread.title || b.thread.threadId.slice(0, 8))}” ${hhmm(b.since, tz)} 起${pendingLabel(b.thread.pendingKind)}，满 ${config.waitingUserGraceMinutes} 分钟（${hhmm(b.until, tz)}）后按空闲处理`;
    default:
      return `t3 ${probeSummary(probe)}`;
  }
}

/** 同一个原因只记一次活动 */
function blockerKey(b: PauseBlocker | null): string {
  if (!b) return "";
  if (b.kind === "just_ended") return `${b.kind}:${b.endedAt}`;
  if (b.kind === "waiting_user_recent") return `${b.kind}:${b.thread.threadId}:${b.since}`;
  return b.kind;
}

async function tickMachine(env: Env, m: MachineRow, now: number) {
  const db = env.DB;
  const live = await fetchLive(env, m.id);

  // 1. 状态观察
  if (live.state === "unknown") {
    if (live.error !== m.last_error) {
      await setLastError(db, m.id, live.error ?? null);
      await logEvent(db, { machineId: m.id, type: "error", source: "system", message: `读取机器状态失败：${live.error}` });
    }
    return;
  }
  if (STABLE.has(live.state) && m.last_state && m.last_state !== live.state) {
    const ownAction = m.last_action_target === live.state && m.last_action_at !== null && now - m.last_action_at < OWN_ACTION_WINDOW_MS;
    if (!ownAction) {
      const from = STATE_LABEL[m.last_state as MachineState] ?? m.last_state;
      await logEvent(db, {
        machineId: m.id,
        type: "external_change",
        source: "external",
        message: `状态变化：${from} → ${STATE_LABEL[live.state]}（非本面板操作）`,
      });
    }
  }
  if (STABLE.has(live.state)) await setObservedState(db, m.id, live.state, now, live.error ?? null);
  else if (m.last_error) await setLastError(db, m.id, null);

  const config = await getConfig(db, m.id);

  // 2. 定时唤醒：到点只触发一次，本分钟不再推进定时暂停
  const wakeDate = planWake(now, config);
  if (wakeDate && (await claimWakeRun(db, m.id, wakeDate, now))) {
    const result = await scheduledWake(env, m, live, config, now);
    await setWakeResult(db, m.id, wakeDate, result);
    return;
  }

  // 3. 定时暂停
  const cycle = currentCycle(now, config.pauseTime, config.timezone);
  const run = await getRun(db, m.id, cycle.cycleDate);
  const plan = planTick({ now, config, cycle, run, live });

  switch (plan.kind) {
    case "idle":
      return;

    case "cancel":
      await finishRun(db, m.id, cycle.cycleDate, "cancelled", now);
      await logEvent(db, { machineId: m.id, type: "schedule_cancelled", source: "schedule", message: "定时暂停已关闭，结束本次等待" });
      return;

    case "give_up_error":
      await finishRun(db, m.id, cycle.cycleDate, "error", now);
      await logEvent(db, { machineId: m.id, type: "error", source: "schedule", message: "暂停多次失败，放弃本次定时暂停" });
      return;

    case "already_paused":
      if (plan.create) {
        await createRun(db, m.id, {
          cycleDate: cycle.cycleDate,
          status: "done",
          result: "already_paused",
          startedAt: now,
          deadlineAt: deadlineFor(cycle, config),
          lastCheckAt: null,
          finishedAt: now,
        });
        await logEvent(db, { machineId: m.id, type: "schedule_skip", source: "schedule", message: `到达定时暂停时间，机器已是${STATE_LABEL[live.state]}状态，无需操作` });
      } else {
        await finishRun(db, m.id, cycle.cycleDate, "already_paused", now);
        await logEvent(db, { machineId: m.id, type: "schedule_done", source: "schedule", message: `机器已${STATE_LABEL[live.state]}，结束等待` });
      }
      return;

    case "pause_now": {
      const message = plan.create ? "定时暂停（未开启等待 t3 任务）" : "已关闭等待 t3 任务，立即暂停";
      let ok = true;
      try {
        await pauseMachine(env, m.id, { source: "schedule", type: "scheduled_pause", message });
      } catch {
        ok = false;
      }
      if (plan.create) {
        await createRun(db, m.id, {
          cycleDate: cycle.cycleDate,
          status: "done",
          result: ok ? "paused" : "error",
          startedAt: now,
          deadlineAt: deadlineFor(cycle, config),
          lastCheckAt: null,
          finishedAt: now,
        });
      } else if (ok) {
        await finishRun(db, m.id, cycle.cycleDate, "paused", now);
      }
      return;
    }

    case "check": {
      const deadlineAt = plan.create ? deadlineFor(cycle, config) : run!.deadlineAt;
      if (plan.create) {
        await createRun(db, m.id, {
          cycleDate: cycle.cycleDate,
          status: "waiting",
          result: null,
          startedAt: now,
          deadlineAt,
          lastCheckAt: null,
          finishedAt: null,
        });
      }
      const prevProbe: ProbeResult | null = m.probe_json ? JSON.parse(m.probe_json) : null;
      const probe = await probeT3(api(env), m.id);
      await saveProbe(db, m.id, probe, now);
      await touchRun(db, m.id, cycle.cycleDate, now);

      const blocker = pauseBlocker(probe, config, now);
      // 上一轮检查时的原因，用来判断原因有没有变化
      const prevBlocker = !plan.create && prevProbe && run?.lastCheckAt ? pauseBlocker(prevProbe, config, run.lastCheckAt) : null;
      const outcome = resolveCheck({ now, deadlineAt, busy: blocker !== null, onTimeout: config.onTimeout });
      const waited = formatDuration(now - cycle.startAt);
      const detail = { probe };

      if (outcome === "wait") {
        if (plan.create) {
          await logEvent(db, {
            machineId: m.id,
            type: "wait_start",
            source: "schedule",
            message: `到达定时暂停时间，${blockerText(blocker!, probe, config)}，开始等待（最晚 ${formatDuration(deadlineAt - cycle.startAt)}）`,
            detail,
          });
        } else if (!probe.ok && (prevProbe?.ok !== false || prevProbe.error !== probe.error)) {
          await logEvent(db, { machineId: m.id, type: "probe_error", source: "schedule", message: `t3 ${probeSummary(probe)}，按有任务处理，继续等待`, detail });
        } else if ((blocker!.kind === "just_ended" || blocker!.kind === "waiting_user_recent") && blockerKey(blocker) !== blockerKey(prevBlocker)) {
          await logEvent(db, { machineId: m.id, type: "wait_grace", source: "schedule", message: `${blockerText(blocker!, probe, config)}，继续等待`, detail });
        }
        return;
      }

      if (outcome === "give_up") {
        await finishRun(db, m.id, cycle.cycleDate, "gave_up", now);
        await logEvent(db, { machineId: m.id, type: "wait_timeout_give_up", source: "schedule", message: `已等待 ${waited}，t3 仍有任务（${probeSummary(probe)}），放弃本次暂停`, detail });
        return;
      }

      let message: string;
      if (outcome === "force") {
        message = `已等待 ${waited}，t3 仍有任务（${probeSummary(probe)}），强制暂停`;
      } else if (plan.create) {
        message = probe.waitingUser
          ? `定时暂停：t3 ${probeSummary(probe)}，等你回复的任务按空闲处理`
          : "定时暂停：t3 没有运行中的任务";
      } else if (prevBlocker?.kind === "just_ended") {
        message = `t3 任务结束已满 ${config.quietAfterEndMinutes} 分钟，等待 ${waited} 后暂停`;
      } else if (prevBlocker?.kind === "waiting_user_recent") {
        message = `等你回复已满 ${config.waitingUserGraceMinutes} 分钟，按空闲处理，等待 ${waited} 后暂停`;
      } else {
        message = probe.waitingUser
          ? `t3 任务已结束（剩 ${probe.waitingUser} 个等你回复，按空闲处理），等待 ${waited} 后暂停`
          : `t3 任务已结束，等待 ${waited} 后暂停`;
      }
      try {
        await pauseMachine(env, m.id, { source: "schedule", type: outcome === "force" ? "wait_timeout_force" : "scheduled_pause", message, detail });
        await finishRun(db, m.id, cycle.cycleDate, outcome === "force" ? "forced" : "paused", now);
      } catch {
        // 已记录错误；保持 waiting，下一轮检查重试
      }
      return;
    }
  }
}

async function scheduledWake(env: Env, m: MachineRow, live: MachineLive, config: ScheduleConfig, now: number): Promise<WakeResult> {
  const db = env.DB;
  const log = (type: string, message: string) => logEvent(db, { machineId: m.id, type, source: "schedule", message });

  // 唤醒时间到了，今晚的定时暂停就不该再执行：结束正在进行的等待；
  // 当前周期还没有记录时补一条已结束的记录，避免下一分钟在等待窗口内又把机器暂停
  const waiting = await getWaitingRun(db, m.id);
  if (waiting) {
    await finishRun(db, m.id, waiting.cycleDate, "woken", now);
    await log("schedule_cancelled", "定时唤醒时间已到，结束今晚的暂停等待");
  }
  const cycle = currentCycle(now, config.pauseTime, config.timezone);
  if (!(await getRun(db, m.id, cycle.cycleDate))) {
    await createRun(db, m.id, {
      cycleDate: cycle.cycleDate,
      status: "done",
      result: "woken",
      startedAt: now,
      deadlineAt: deadlineFor(cycle, config),
      lastCheckAt: null,
      finishedAt: now,
    });
  }

  if (live.state === "running") {
    await log("wake_skip", "定时唤醒：机器已在运行，跳过");
    return "already_running";
  }
  if (live.state !== "suspended" && live.state !== "stopped") {
    await log("wake_skip", `定时唤醒：机器当前是${STATE_LABEL[live.state]}状态，跳过`);
    return "skipped";
  }
  if (live.cooldownUntil && Date.parse(live.cooldownUntil) > now) {
    const until = new Intl.DateTimeFormat("zh-CN", { timeZone: config.timezone, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      Date.parse(live.cooldownUntil),
    );
    await log("error", `定时唤醒失败：机器处于 instabox 冷却期（${until} 结束），本次不再重试`);
    return "cooldown";
  }
  try {
    const ib = api(env);
    if (live.state === "suspended") await ib.resume(m.id);
    else await ib.start(m.id);
  } catch (e) {
    await log("error", `定时唤醒失败：${describeError(e)}`);
    return "error";
  }
  await recordAction(db, m.id, "running", now);
  await log("scheduled_wake", live.state === "stopped" ? "定时启动" : "定时唤醒");
  return "woken";
}
