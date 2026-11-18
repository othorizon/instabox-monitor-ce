import { Hono } from "hono";
import { verifyAccess } from "./access";
import { ActionError, api, describeError, pauseMachine, wakeMachine } from "./actions";
import { fetchLive, runCron } from "./cron";
import {
  addMachine,
  finishRun,
  getConfig,
  getLatestRun,
  getLatestWakeRun,
  getMachine,
  getRun,
  getWaitingRun,
  createRun,
  deleteSkippedRun,
  listEvents,
  listMachines,
  logEvent,
  removeMachine,
  saveConfig,
  saveProbe,
  setRunDeadline,
  EVENT_RETENTION_MS,
  type Env,
  type MachineRow,
} from "./db";
import { currentCycle, deadlineFor, skipState } from "./scheduler";
import { probeT3 } from "./t3probe";
import { formatMonthDayTime, isValidTimeZone, nextPauseAt, nextWeeklyAt, parseHHMM, zonedToEpoch } from "./time";
import { daysLabel, formatDuration } from "../shared/labels";
import type { InstaboxMachineSummary, MachineOverview, ScheduleConfig } from "../shared/types";

const app = new Hono<{ Bindings: Env; Variables: { email: string } }>();

app.use("/api/*", async (c, next) => {
  const r = await verifyAccess(c.req.raw, c.env);
  if (!r.ok) return c.json({ error: r.error }, r.status as 401);
  c.set("email", r.email);
  await next();
});

app.onError((err, c) => {
  if (err instanceof ActionError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: describeError(err) }, 500);
});

/** 当前周期、下一周期及两者的执行记录，以及“跳过这次”的状态 */
async function skipContext(env: Env, machineId: string, config: ScheduleConfig, now: number) {
  const cur = currentCycle(now, config.pauseTime, config.timezone);
  const nextAt = nextPauseAt(now, config.pauseTime, config.timezone);
  const next = { cycleDate: currentCycle(nextAt, config.pauseTime, config.timezone).cycleDate, startAt: nextAt };
  const afterNext = nextPauseAt(nextAt, config.pauseTime, config.timezone);
  const [runCur, runNext] = await Promise.all([getRun(env.DB, machineId, cur.cycleDate), getRun(env.DB, machineId, next.cycleDate)]);
  return { cur, next, runCur, runNext, ...skipState({ now, config, cur, next, afterNext, runCur, runNext }) };
}

async function overviewFor(env: Env, m: MachineRow, now: number): Promise<MachineOverview> {
  const [live, config] = await Promise.all([fetchLive(env, m.id), getConfig(env.DB, m.id)]);
  const [sc, latestRun, wakeRun] = await Promise.all([
    skipContext(env, m.id, config, now),
    getLatestRun(env.DB, m.id),
    getLatestWakeRun(env.DB, m.id),
  ]);
  // 跳过记录由提示条展示，不当作“最近一次结果”
  const run = sc.runCur && sc.runCur.result !== "skipped" ? sc.runCur : latestRun?.result === "skipped" ? null : latestRun;
  return {
    id: m.id,
    name: m.name,
    live,
    lastStateAt: m.last_state_at,
    config,
    run,
    nextPauseAt: config.enabled ? nextPauseAt(now, config.pauseTime, config.timezone) : null,
    skip: sc.skip,
    skipTarget: sc.target,
    wakeRun,
    nextWakeAt: config.wakeEnabled ? nextWeeklyAt(now, config.wakeTime, config.wakeDays, config.timezone) : null,
    probe: m.probe_json ? JSON.parse(m.probe_json) : null,
    probeAt: m.probe_at,
  };
}

async function requireMachine(env: Env, id: string) {
  const m = await getMachine(env.DB, id);
  if (!m) throw new ActionError("未监管这台机器", 404);
  return m;
}

app.get("/api/me", (c) => c.json({ email: c.get("email") }));

app.get("/api/overview", async (c) => {
  const now = Date.now();
  const machines = await listMachines(c.env.DB);
  const list = await Promise.all(machines.map((m) => overviewFor(c.env, m, now)));
  return c.json({ machines: list, now });
});

app.get("/api/machines/:id", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  return c.json(await overviewFor(c.env, m, Date.now()));
});

app.get("/api/instabox/machines", async (c) => {
  const [remote, local] = await Promise.all([api(c.env).listMachines(), listMachines(c.env.DB)]);
  const monitored = new Set(local.map((m) => m.id));
  const list: InstaboxMachineSummary[] = remote
    .filter((m) => m.state !== "deleted" && m.state !== "deleting")
    .map((m) => ({ id: m.id, name: m.name, state: m.state, monitored: monitored.has(m.id) }));
  return c.json({ machines: list });
});

app.post("/api/machines", async (c) => {
  const body = await c.req.json<{ id?: string }>();
  if (!body.id) throw new ActionError("缺少机器 ID");
  let name: string;
  try {
    name = (await api(c.env).getMachine(body.id)).name;
  } catch (e) {
    throw new ActionError(`找不到这台机器：${describeError(e)}`, 404);
  }
  const now = Date.now();
  await addMachine(c.env.DB, body.id, name, now);
  await logEvent(c.env.DB, { machineId: body.id, type: "machine_added", source: "user", message: `开始监管 ${name}` });
  const m = await requireMachine(c.env, body.id);
  return c.json(await overviewFor(c.env, m, now));
});

app.delete("/api/machines/:id", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  await removeMachine(c.env.DB, m.id);
  await logEvent(c.env.DB, { machineId: m.id, type: "machine_removed", source: "user", message: `停止监管 ${m.name}` });
  return c.json({ ok: true });
});

app.post("/api/machines/:id/pause", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  await pauseMachine(c.env, m.id, { source: "user", type: "manual_pause", message: "手动暂停" });
  return c.json(await overviewFor(c.env, m, Date.now()));
});

app.post("/api/machines/:id/wake", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  await wakeMachine(c.env, m.id);
  return c.json(await overviewFor(c.env, m, Date.now()));
});

/** 手动刷新 t3 任务状态。注意：exec 会被 instabox 视为活动，重置空闲计时。 */
app.post("/api/machines/:id/probe", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  const live = await fetchLive(c.env, m.id);
  if (live.state !== "running") throw new ActionError("机器未运行，无法检测 t3 任务", 409);
  const now = Date.now();
  const probe = await probeT3(api(c.env), m.id);
  await saveProbe(c.env.DB, m.id, probe, now);
  return c.json({ probe, probeAt: now });
});

/** 高级设置的上限（分钟） */
export const MAX_GRACE_MINUTES = 240;

function validateConfig(input: any, prev: ScheduleConfig): ScheduleConfig {
  const errors: string[] = [];
  const pauseTime = String(input?.pauseTime ?? "");
  if (!parseHHMM(pauseTime)) errors.push("暂停时间格式应为 HH:MM");
  const timezone = String(input?.timezone ?? "");
  if (!isValidTimeZone(timezone)) errors.push("时区无效");
  const maxWaitMinutes = Number(input?.maxWaitMinutes);
  if (!Number.isInteger(maxWaitMinutes) || maxWaitMinutes < 5 || maxWaitMinutes > 20 * 60) {
    errors.push("最长等待时间必须在 5 分钟到 20 小时之间");
  }
  const onTimeout = input?.onTimeout;
  if (onTimeout !== "force" && onTimeout !== "give_up") errors.push("超时处理方式无效");
  // 旧页面不会提交这两项，保留原值
  const grace = (key: "quietAfterEndMinutes" | "waitingUserGraceMinutes", label: string) => {
    const v = input?.[key] === undefined ? prev[key] : Number(input[key]);
    if (!Number.isInteger(v) || v < 0 || v > MAX_GRACE_MINUTES) errors.push(`${label}必须在 0 到 ${MAX_GRACE_MINUTES} 分钟之间`);
    return v;
  };
  const quietAfterEndMinutes = grace("quietAfterEndMinutes", "任务结束后再等的时间");
  const waitingUserGraceMinutes = grace("waitingUserGraceMinutes", "等你回复的时间");
  const wakeEnabled = !!input?.wakeEnabled;
  const wakeTime = String(input?.wakeTime ?? "");
  if (!parseHHMM(wakeTime)) errors.push("唤醒时间格式应为 HH:MM");
  const rawDays: unknown[] = Array.isArray(input?.wakeDays) ? input.wakeDays : [];
  const wakeDays = [...new Set(rawDays.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
  if (wakeDays.length !== rawDays.length) errors.push("唤醒的星期无效");
  if (wakeEnabled && !wakeDays.length) errors.push("定时唤醒至少要选一天");
  if (errors.length) throw new ActionError(errors.join("；"));
  return {
    enabled: !!input.enabled,
    pauseTime,
    timezone,
    waitForT3: !!input.waitForT3,
    waitingUserCountsAsBusy: !!input.waitingUserCountsAsBusy,
    maxWaitMinutes,
    onTimeout,
    quietAfterEndMinutes,
    waitingUserGraceMinutes,
    wakeEnabled,
    wakeTime,
    wakeDays,
  };
}

function describeConfig(c: ScheduleConfig): string {
  let pause: string;
  if (!c.enabled) pause = "关闭定时暂停";
  else if (!c.waitForT3) pause = `每天 ${c.pauseTime} 直接暂停`;
  else {
    const extra = [
      c.waitingUserCountsAsBusy ? "等你回复的任务也继续等" : c.waitingUserGraceMinutes ? `等你回复满 ${c.waitingUserGraceMinutes} 分钟才按空闲处理` : "",
      c.quietAfterEndMinutes ? `任务结束后至少再等 ${c.quietAfterEndMinutes} 分钟` : "",
    ].filter(Boolean);
    pause = `每天 ${c.pauseTime} 暂停，等待 t3 任务（最长 ${formatDuration(c.maxWaitMinutes * 60_000)}，超时${c.onTimeout === "force" ? "强制暂停" : "放弃本次暂停"}）${extra.map((x) => "，" + x).join("")}`;
  }
  const wake = c.wakeEnabled ? `${daysLabel(c.wakeDays)} ${c.wakeTime} 唤醒` : "关闭定时唤醒";
  return `${pause}；${wake}`;
}

/** 只切换了开关（首页快捷开关）时，活动记录只写这一项 */
function describeChange(prev: ScheduleConfig, next: ScheduleConfig): string {
  const same = (k: keyof ScheduleConfig) => JSON.stringify(prev[k]) === JSON.stringify(next[k]);
  const keys = Object.keys(next) as (keyof ScheduleConfig)[];
  const changed = keys.filter((k) => !same(k));
  if (changed.length === 1 && changed[0] === "enabled") return next.enabled ? `开启定时暂停（每天 ${next.pauseTime}）` : "关闭定时暂停";
  if (changed.length === 1 && changed[0] === "wakeEnabled")
    return next.wakeEnabled ? `开启定时唤醒（${daysLabel(next.wakeDays)} ${next.wakeTime}）` : "关闭定时唤醒";
  return `修改定时计划：${describeConfig(next)}`;
}

app.put("/api/machines/:id/config", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  const prev = await getConfig(c.env.DB, m.id);
  const next = validateConfig(await c.req.json(), prev);
  const now = Date.now();
  await saveConfig(c.env.DB, m.id, next, now);

  // 正在等待的记录：时间点或时区变了就结束它（新周期会按新配置重新开始）；否则按新配置更新截止时间
  const waiting = await getWaitingRun(c.env.DB, m.id);
  if (waiting) {
    if (prev.pauseTime !== next.pauseTime || prev.timezone !== next.timezone) {
      await finishRun(c.env.DB, m.id, waiting.cycleDate, "cancelled", now);
      await logEvent(c.env.DB, { machineId: m.id, type: "schedule_cancelled", source: "user", message: "暂停时间已修改，结束本次等待" });
    } else {
      const [y, mo, d] = waiting.cycleDate.split("-").map(Number) as [number, number, number];
      const t = parseHHMM(next.pauseTime)!;
      const startAt = zonedToEpoch(y, mo, d, t.hh, t.mm, next.timezone);
      await setRunDeadline(c.env.DB, m.id, waiting.cycleDate, deadlineFor({ cycleDate: waiting.cycleDate, startAt }, next));
    }
  }
  await logEvent(c.env.DB, { machineId: m.id, type: "config_change", source: "user", message: describeChange(prev, next) });
  return c.json(await overviewFor(c.env, m, now));
});

/** 跳过这一次定时暂停；cycleDate 必须是页面上看到的那一次，防止页面过期时跳错 */
app.post("/api/machines/:id/skip-pause", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  const { cycleDate } = await c.req.json<{ cycleDate?: string }>();
  const now = Date.now();
  const config = await getConfig(c.env.DB, m.id);
  const sc = await skipContext(c.env, m.id, config, now);
  const t = sc.target;
  if (!t || t.cycleDate !== cycleDate) throw new ActionError("页面状态已过期，请刷新后再试", 409);
  const when = formatMonthDayTime(t.at, config.timezone);
  if (t.waiting) {
    await finishRun(c.env.DB, m.id, t.cycleDate, "skipped", now);
    await logEvent(c.env.DB, { machineId: m.id, type: "skip_pause", source: "user", message: `跳过 ${when} 的定时暂停（结束等待）` });
  } else {
    const existing = await getRun(c.env.DB, m.id, t.cycleDate);
    if (existing) throw new ActionError("这次定时暂停已经执行过了", 409);
    const cycle = { cycleDate: t.cycleDate, startAt: t.at };
    await createRun(c.env.DB, m.id, {
      cycleDate: t.cycleDate,
      status: "done",
      result: "skipped",
      startedAt: now,
      deadlineAt: deadlineFor(cycle, config),
      lastCheckAt: null,
      finishedAt: now,
    });
    await logEvent(c.env.DB, { machineId: m.id, type: "skip_pause", source: "user", message: `跳过 ${when} 的定时暂停` });
  }
  return c.json(await overviewFor(c.env, m, now));
});

/** 撤销跳过：删掉 skipped 记录，这一次按正常流程处理（仍在等待窗口内会重新开始等待） */
app.delete("/api/machines/:id/skip-pause", async (c) => {
  const m = await requireMachine(c.env, c.req.param("id"));
  const { cycleDate } = await c.req.json<{ cycleDate?: string }>();
  if (!cycleDate) throw new ActionError("缺少 cycleDate");
  const now = Date.now();
  const config = await getConfig(c.env.DB, m.id);
  const sc = await skipContext(c.env, m.id, config, now);
  if (await deleteSkippedRun(c.env.DB, m.id, cycleDate)) {
    const at = sc.skip?.cycleDate === cycleDate ? sc.skip.at : null;
    const when = at ? formatMonthDayTime(at, config.timezone) : cycleDate;
    await logEvent(c.env.DB, { machineId: m.id, type: "unskip_pause", source: "user", message: `撤销跳过 ${when} 的定时暂停` });
  }
  return c.json(await overviewFor(c.env, m, now));
});

app.get("/api/events", async (c) => {
  const q = (k: string) => c.req.query(k);
  const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);
  const since = Date.now() - EVENT_RETENTION_MS;
  const machineId = q("machine") || undefined;

  // 增量：after=<最新一条的 id>，返回之后新增的记录；hasMore 表示新增太多、客户端应整页重载
  const afterId = int(q("after"));
  if (afterId !== undefined) {
    return c.json(await listEvents(c.env.DB, { since, machineId, limit: 200, afterId }));
  }

  // 分页：before=<ts>:<id>，返回比该条更早的一页
  const limit = Math.min(200, Math.max(1, int(q("limit")) ?? 50));
  const m = /^(\d+):(\d+)$/.exec(q("before") ?? "");
  const before = m ? { ts: Number(m[1]), id: Number(m[2]) } : undefined;
  return c.json(await listEvents(c.env.DB, { since, machineId, limit, before }));
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
