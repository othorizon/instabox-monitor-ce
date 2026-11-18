// D1 读写

import { DEFAULT_CONFIG, type ActivityEvent, type NightlyRun, type ScheduleConfig, type ProbeResult, type WakeResult, type WakeRun } from "../shared/types";

export interface Env {
  DB: D1Database;
  INSTABOX_API_KEY: string;
  /** 可选，覆盖 API 地址（本地测试用） */
  INSTABOX_API_URL?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  DEV_SKIP_ACCESS?: string;
}

export interface MachineRow {
  id: string;
  name: string;
  added_at: number;
  last_state: string | null;
  last_state_at: number | null;
  last_action_at: number | null;
  last_action_target: string | null;
  probe_json: string | null;
  probe_at: number | null;
  last_error: string | null;
}

export const EVENT_RETENTION_MS = 30 * 24 * 3600_000;

export async function listMachines(db: D1Database): Promise<MachineRow[]> {
  const r = await db.prepare("SELECT * FROM machines ORDER BY added_at").all<MachineRow>();
  return r.results;
}

export async function getMachine(db: D1Database, id: string): Promise<MachineRow | null> {
  return db.prepare("SELECT * FROM machines WHERE id = ?").bind(id).first<MachineRow>();
}

export async function addMachine(db: D1Database, id: string, name: string, now: number) {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO machines (id, name, added_at) VALUES (?, ?, ?)").bind(id, name, now),
    db.prepare("INSERT OR IGNORE INTO pause_config (machine_id, updated_at) VALUES (?, ?)").bind(id, now),
  ]);
}

export async function removeMachine(db: D1Database, id: string) {
  await db.batch([
    db.prepare("DELETE FROM wake_runs WHERE machine_id = ?").bind(id),
    db.prepare("DELETE FROM nightly_runs WHERE machine_id = ?").bind(id),
    db.prepare("DELETE FROM pause_config WHERE machine_id = ?").bind(id),
    db.prepare("DELETE FROM machines WHERE id = ?").bind(id),
  ]);
}

interface ConfigRow {
  enabled: number;
  pause_time: string;
  timezone: string;
  wait_for_t3: number;
  waiting_user_counts_as_busy: number;
  max_wait_minutes: number;
  on_timeout: "force" | "give_up";
  quiet_after_end_minutes: number;
  waiting_user_grace_minutes: number;
  wake_enabled: number;
  wake_time: string;
  wake_days: string;
}

export function parseDays(s: string): number[] {
  return [...new Set(s.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
}

export async function getConfig(db: D1Database, machineId: string): Promise<ScheduleConfig> {
  const r = await db.prepare("SELECT * FROM pause_config WHERE machine_id = ?").bind(machineId).first<ConfigRow>();
  if (!r) return { ...DEFAULT_CONFIG };
  return {
    enabled: !!r.enabled,
    pauseTime: r.pause_time,
    timezone: r.timezone,
    waitForT3: !!r.wait_for_t3,
    waitingUserCountsAsBusy: !!r.waiting_user_counts_as_busy,
    maxWaitMinutes: r.max_wait_minutes,
    onTimeout: r.on_timeout,
    quietAfterEndMinutes: r.quiet_after_end_minutes,
    waitingUserGraceMinutes: r.waiting_user_grace_minutes,
    wakeEnabled: !!r.wake_enabled,
    wakeTime: r.wake_time,
    wakeDays: parseDays(r.wake_days),
  };
}

export async function saveConfig(db: D1Database, machineId: string, c: ScheduleConfig, now: number) {
  await db
    .prepare(
      `INSERT INTO pause_config (machine_id, enabled, pause_time, timezone, wait_for_t3, waiting_user_counts_as_busy, max_wait_minutes, on_timeout,
         quiet_after_end_minutes, waiting_user_grace_minutes, wake_enabled, wake_time, wake_days, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id) DO UPDATE SET enabled = excluded.enabled, pause_time = excluded.pause_time,
         timezone = excluded.timezone, wait_for_t3 = excluded.wait_for_t3,
         waiting_user_counts_as_busy = excluded.waiting_user_counts_as_busy,
         max_wait_minutes = excluded.max_wait_minutes, on_timeout = excluded.on_timeout,
         quiet_after_end_minutes = excluded.quiet_after_end_minutes,
         waiting_user_grace_minutes = excluded.waiting_user_grace_minutes,
         wake_enabled = excluded.wake_enabled, wake_time = excluded.wake_time, wake_days = excluded.wake_days,
         updated_at = excluded.updated_at`,
    )
    .bind(
      machineId, +c.enabled, c.pauseTime, c.timezone, +c.waitForT3, +c.waitingUserCountsAsBusy, c.maxWaitMinutes, c.onTimeout,
      c.quietAfterEndMinutes, c.waitingUserGraceMinutes, +c.wakeEnabled, c.wakeTime, c.wakeDays.join(","), now,
    )
    .run();
}

interface RunRow {
  cycle_date: string;
  status: "waiting" | "done";
  result: NightlyRun["result"];
  started_at: number;
  deadline_at: number;
  last_check_at: number | null;
  finished_at: number | null;
}

function toRun(r: RunRow): NightlyRun {
  return {
    cycleDate: r.cycle_date,
    status: r.status,
    result: r.result,
    startedAt: r.started_at,
    deadlineAt: r.deadline_at,
    lastCheckAt: r.last_check_at,
    finishedAt: r.finished_at,
  };
}

export async function getRun(db: D1Database, machineId: string, cycleDate: string): Promise<NightlyRun | null> {
  const r = await db
    .prepare("SELECT * FROM nightly_runs WHERE machine_id = ? AND cycle_date = ?")
    .bind(machineId, cycleDate)
    .first<RunRow>();
  return r ? toRun(r) : null;
}

export async function getWaitingRun(db: D1Database, machineId: string): Promise<NightlyRun | null> {
  const r = await db
    .prepare("SELECT * FROM nightly_runs WHERE machine_id = ? AND status = 'waiting' ORDER BY cycle_date DESC LIMIT 1")
    .bind(machineId)
    .first<RunRow>();
  return r ? toRun(r) : null;
}

export async function getLatestRun(db: D1Database, machineId: string): Promise<NightlyRun | null> {
  const r = await db
    .prepare("SELECT * FROM nightly_runs WHERE machine_id = ? ORDER BY cycle_date DESC LIMIT 1")
    .bind(machineId)
    .first<RunRow>();
  return r ? toRun(r) : null;
}

export async function createRun(db: D1Database, machineId: string, run: NightlyRun) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO nightly_runs (machine_id, cycle_date, status, result, started_at, deadline_at, last_check_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(machineId, run.cycleDate, run.status, run.result, run.startedAt, run.deadlineAt, run.lastCheckAt, run.finishedAt)
    .run();
}

export async function touchRun(db: D1Database, machineId: string, cycleDate: string, lastCheckAt: number) {
  await db
    .prepare("UPDATE nightly_runs SET last_check_at = ? WHERE machine_id = ? AND cycle_date = ?")
    .bind(lastCheckAt, machineId, cycleDate)
    .run();
}

export async function setRunDeadline(db: D1Database, machineId: string, cycleDate: string, deadlineAt: number) {
  await db
    .prepare("UPDATE nightly_runs SET deadline_at = ? WHERE machine_id = ? AND cycle_date = ? AND status = 'waiting'")
    .bind(deadlineAt, machineId, cycleDate)
    .run();
}

export async function finishRun(db: D1Database, machineId: string, cycleDate: string, result: NonNullable<NightlyRun["result"]>, now: number) {
  await db
    .prepare("UPDATE nightly_runs SET status = 'done', result = ?, finished_at = ? WHERE machine_id = ? AND cycle_date = ? AND status = 'waiting'")
    .bind(result, now, machineId, cycleDate)
    .run();
}

export async function setObservedState(db: D1Database, id: string, state: string, now: number, error: string | null) {
  await db
    .prepare(
      `UPDATE machines SET
         last_state_at = CASE WHEN last_state IS ? THEN last_state_at ELSE ? END,
         last_state = ?, last_error = ?
       WHERE id = ?`,
    )
    .bind(state, now, state, error, id)
    .run();
}

export async function setLastError(db: D1Database, id: string, error: string | null) {
  await db.prepare("UPDATE machines SET last_error = ? WHERE id = ?").bind(error, id).run();
}

export async function recordAction(db: D1Database, id: string, target: string, now: number) {
  await db.prepare("UPDATE machines SET last_action_at = ?, last_action_target = ? WHERE id = ?").bind(now, target, id).run();
}

export async function saveProbe(db: D1Database, id: string, probe: ProbeResult, now: number) {
  await db.prepare("UPDATE machines SET probe_json = ?, probe_at = ? WHERE id = ?").bind(JSON.stringify(probe), now, id).run();
}

export async function logEvent(
  db: D1Database,
  e: { machineId: string | null; type: string; source: ActivityEvent["source"]; message: string; detail?: unknown; ts?: number },
) {
  await db
    .prepare("INSERT INTO events (machine_id, ts, type, source, message, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(e.machineId, e.ts ?? Date.now(), e.type, e.source, e.message, e.detail === undefined ? null : JSON.stringify(e.detail))
    .run();
}

type EventRow = { id: number; machine_id: string | null; ts: number; type: string; source: ActivityEvent["source"]; message: string };

/**
 * 分页读取活动（按 ts、id 倒序）。
 * - before：游标分页，取比 (ts, id) 更早的一页
 * - afterId：增量轮询，取 id 更大的新记录
 * 多取一条用来判断 hasMore。
 */
export async function listEvents(
  db: D1Database,
  opts: { since: number; machineId?: string; limit: number; before?: { ts: number; id: number }; afterId?: number },
): Promise<{ events: ActivityEvent[]; hasMore: boolean }> {
  const where = ["ts >= ?"];
  const args: unknown[] = [opts.since];
  if (opts.machineId) {
    where.push("(machine_id = ? OR machine_id IS NULL)");
    args.push(opts.machineId);
  }
  if (opts.before) {
    where.push("(ts < ? OR (ts = ? AND id < ?))");
    args.push(opts.before.ts, opts.before.ts, opts.before.id);
  }
  if (opts.afterId !== undefined) {
    where.push("id > ?");
    args.push(opts.afterId);
  }
  args.push(opts.limit + 1);
  const r = await db
    .prepare(`SELECT id, machine_id, ts, type, source, message FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(...args)
    .all<EventRow>();
  const rows = r.results.slice(0, opts.limit);
  return {
    events: rows.map((x) => ({ id: x.id, machineId: x.machine_id, ts: x.ts, type: x.type, source: x.source, message: x.message })),
    hasMore: r.results.length > opts.limit,
  };
}

export async function pruneOld(db: D1Database, now: number) {
  await db.batch([
    db.prepare("DELETE FROM events WHERE ts < ?").bind(now - EVENT_RETENTION_MS),
    db.prepare("DELETE FROM nightly_runs WHERE started_at < ?").bind(now - 2 * EVENT_RETENTION_MS),
    db.prepare("DELETE FROM wake_runs WHERE ts < ?").bind(now - 2 * EVENT_RETENTION_MS),
  ]);
}

// ---------- 定时唤醒 ----------

export async function hasWakeRun(db: D1Database, machineId: string, wakeDate: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM wake_runs WHERE machine_id = ? AND wake_date = ?").bind(machineId, wakeDate).first();
  return r !== null;
}

/** 占位一次当天的唤醒；返回 false 表示已经有了（防止重复触发） */
export async function claimWakeRun(db: D1Database, machineId: string, wakeDate: string, now: number): Promise<boolean> {
  const r = await db
    .prepare("INSERT OR IGNORE INTO wake_runs (machine_id, wake_date, result, ts) VALUES (?, ?, NULL, ?)")
    .bind(machineId, wakeDate, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function setWakeResult(db: D1Database, machineId: string, wakeDate: string, result: WakeResult) {
  await db.prepare("UPDATE wake_runs SET result = ? WHERE machine_id = ? AND wake_date = ?").bind(result, machineId, wakeDate).run();
}

export async function getLatestWakeRun(db: D1Database, machineId: string): Promise<WakeRun | null> {
  const r = await db
    .prepare("SELECT wake_date, result, ts FROM wake_runs WHERE machine_id = ? ORDER BY wake_date DESC LIMIT 1")
    .bind(machineId)
    .first<{ wake_date: string; result: WakeResult | null; ts: number }>();
  return r ? { wakeDate: r.wake_date, result: r.result, ts: r.ts } : null;
}

/** 撤销跳过：删除这次的 skipped 记录，返回是否删到了 */
export async function deleteSkippedRun(db: D1Database, machineId: string, cycleDate: string): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM nightly_runs WHERE machine_id = ? AND cycle_date = ? AND result = 'skipped'")
    .bind(machineId, cycleDate)
    .run();
  return (r.meta.changes ?? 0) > 0;
}
