import { describe, expect, it } from "vitest";
import { planTick, planWake, resolveCheck, deadlineFor, skipState, CHECK_INTERVAL_MS, WAKE_TRIGGER_WINDOW_MS } from "../src/worker/scheduler";
import { currentCycle, isoWeekday, nextPauseAt, nextWeeklyAt, zonedToEpoch } from "../src/worker/time";
import { daysLabel } from "../src/shared/labels";
import { isBusy, parseProbeOutput } from "../src/worker/t3probe";
import { DEFAULT_CONFIG, type NightlyRun, type ProbeResult, type ProbeThread, type ScheduleConfig } from "../src/shared/types";
import { pauseBlocker } from "../src/shared/pauseGate";

const TZ = "Asia/Shanghai";
const at = (d: number, hh: number, mm = 0) => zonedToEpoch(2026, 11, d, hh, mm, TZ);
const cfg = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({ ...DEFAULT_CONFIG, ...over });
const running = { state: "running" as const };

describe("time", () => {
  it("22:00 Shanghai is 14:00 UTC", () => {
    expect(new Date(at(12, 22)).toISOString()).toBe("2026-11-12T14:00:00.000Z");
  });

  it("cycle before pause time belongs to yesterday", () => {
    const c = currentCycle(at(13, 3), "22:00", TZ);
    expect(c.cycleDate).toBe("2026-11-12");
    expect(c.startAt).toBe(at(12, 22));
  });

  it("cycle after pause time belongs to today", () => {
    expect(currentCycle(at(12, 22, 1), "22:00", TZ).cycleDate).toBe("2026-11-12");
    expect(currentCycle(at(12, 22, 0), "22:00", TZ).cycleDate).toBe("2026-11-12");
    expect(currentCycle(at(12, 21, 59), "22:00", TZ).cycleDate).toBe("2026-11-11");
  });

  it("next pause", () => {
    expect(nextPauseAt(at(12, 21), "22:00", TZ)).toBe(at(12, 22));
    expect(nextPauseAt(at(12, 23), "22:00", TZ)).toBe(at(13, 22));
  });

  it("handles DST zones", () => {
    // 2026-03-08 美国夏令时开始；22:00 纽约 = 02:00 UTC 次日
    const t = zonedToEpoch(2026, 3, 8, 22, 0, "America/New_York");
    expect(new Date(t).toISOString()).toBe("2026-03-09T02:00:00.000Z");
  });
});

describe("planTick", () => {
  const cycle = currentCycle(at(12, 22), "22:00", TZ);

  it("does nothing before pause time", () => {
    const c = currentCycle(at(12, 21), "22:00", TZ);
    expect(planTick({ now: at(12, 21), config: cfg(), cycle: c, run: null, live: running })).toEqual({ kind: "idle" });
  });

  it("starts checking at pause time", () => {
    expect(planTick({ now: at(12, 22), config: cfg(), cycle, run: null, live: running })).toEqual({ kind: "check", create: true });
  });

  it("pauses immediately without wait", () => {
    expect(planTick({ now: at(12, 22), config: cfg({ waitForT3: false }), cycle, run: null, live: running })).toEqual({ kind: "pause_now", create: true });
  });

  it("does not start after the window (e.g. fresh deploy at noon)", () => {
    const c = currentCycle(at(13, 12), "22:00", TZ);
    expect(planTick({ now: at(13, 12), config: cfg(), cycle: c, run: null, live: running })).toEqual({ kind: "idle" });
  });

  it("skips when already paused", () => {
    expect(planTick({ now: at(12, 22), config: cfg(), cycle, run: null, live: { state: "suspended" } })).toEqual({ kind: "already_paused", create: true });
  });

  it("disabled config does nothing", () => {
    expect(planTick({ now: at(12, 22), config: cfg({ enabled: false }), cycle, run: null, live: running })).toEqual({ kind: "idle" });
  });

  const waiting = (over: Partial<NightlyRun> = {}): NightlyRun => ({
    cycleDate: cycle.cycleDate,
    status: "waiting",
    result: null,
    startedAt: at(12, 22),
    deadlineAt: deadlineFor(cycle, cfg()),
    lastCheckAt: at(12, 22),
    finishedAt: null,
    ...over,
  });

  it("checks every 5 minutes while waiting", () => {
    expect(planTick({ now: at(12, 22, 4), config: cfg(), cycle, run: waiting(), live: running })).toEqual({ kind: "idle" });
    expect(planTick({ now: at(12, 22) + CHECK_INTERVAL_MS, config: cfg(), cycle, run: waiting(), live: running })).toEqual({ kind: "check", create: false });
  });

  it("checks at deadline even if last check was recent", () => {
    const run = waiting({ lastCheckAt: at(13, 5, 58) });
    expect(planTick({ now: at(13, 6), config: cfg(), cycle, run, live: running })).toEqual({ kind: "check", create: false });
  });

  it("waiting continues across midnight in the same cycle", () => {
    const c = currentCycle(at(13, 2), "22:00", TZ);
    expect(c.cycleDate).toBe(cycle.cycleDate);
  });

  it("ends waiting when machine got paused elsewhere", () => {
    expect(planTick({ now: at(12, 23), config: cfg(), cycle, run: waiting(), live: { state: "suspended" } })).toEqual({ kind: "already_paused", create: false });
  });

  it("done run stays idle (manual wake after auto pause is not re-paused)", () => {
    expect(planTick({ now: at(12, 23), config: cfg(), cycle, run: waiting({ status: "done", result: "paused" }), live: running })).toEqual({ kind: "idle" });
  });

  it("cancels when disabled mid-wait", () => {
    expect(planTick({ now: at(12, 23), config: cfg({ enabled: false }), cycle, run: waiting(), live: running })).toEqual({ kind: "cancel" });
  });

  it("pauses now when wait turned off mid-wait", () => {
    expect(planTick({ now: at(12, 23), config: cfg({ waitForT3: false }), cycle, run: waiting(), live: running })).toEqual({ kind: "pause_now", create: false });
  });
});

describe("resolveCheck", () => {
  const deadlineAt = at(13, 6);
  it("pauses when idle", () => {
    expect(resolveCheck({ now: at(12, 23), deadlineAt, busy: false, onTimeout: "give_up" })).toBe("pause");
  });
  it("waits when busy before deadline", () => {
    expect(resolveCheck({ now: at(12, 23), deadlineAt, busy: true, onTimeout: "give_up" })).toBe("wait");
  });
  it("timeout actions", () => {
    expect(resolveCheck({ now: deadlineAt, deadlineAt, busy: true, onTimeout: "give_up" })).toBe("give_up");
    expect(resolveCheck({ now: deadlineAt, deadlineAt, busy: true, onTimeout: "force" })).toBe("force");
  });
});

describe("t3 probe", () => {
  const out = JSON.stringify({
    ok: true,
    threads: [
      { threadId: "a", title: "A", state: "running", pendingKind: null },
      { threadId: "b", title: "B", state: "waiting_user", pendingKind: "user_input_request" },
    ],
  });

  it("parses counts", () => {
    const p = parseProbeOutput(out, 0);
    expect(p).toMatchObject({ ok: true, running: 1, waitingUser: 1 });
  });

  const gate = (o: Partial<ScheduleConfig> = {}) => ({ waitingUserCountsAsBusy: false, quietAfterEndMinutes: 0, waitingUserGraceMinutes: 0, ...o });
  const NOW = Date.parse("2026-11-12T18:00:00Z");
  const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

  it("waiting-user threads count as idle by default", () => {
    const onlyWaiting = parseProbeOutput(JSON.stringify({ ok: true, threads: [{ threadId: "b", title: "B", state: "waiting_user" }] }), 0);
    expect(isBusy(onlyWaiting, gate(), NOW)).toBe(false);
    expect(isBusy(onlyWaiting, gate({ waitingUserCountsAsBusy: true }), NOW)).toBe(true);
  });

  it("probe failure counts as busy", () => {
    const p = parseProbeOutput("garbage", 1);
    expect(p.ok).toBe(false);
    expect(isBusy(p, gate(), NOW)).toBe(true);
  });

  it("parses lastEndedAt and waitingSince", () => {
    const p = parseProbeOutput(
      JSON.stringify({ ok: true, lastEndedAt: iso(3), threads: [{ threadId: "b", title: "B", state: "waiting_user", waitingSince: iso(5) }] }),
      0,
    );
    expect(p.lastEndedAt).toBe(iso(3));
    expect(p.threads[0]!.waitingSince).toBe(iso(5));
    // 旧版本探测脚本没有这个字段
    expect(parseProbeOutput(out, 0).lastEndedAt).toBeNull();
  });
});

describe("pause gate", () => {
  const NOW = Date.parse("2026-11-12T18:00:00Z");
  const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const cfg = { waitingUserCountsAsBusy: false, quietAfterEndMinutes: 10, waitingUserGraceMinutes: 30 };
  const probe = (o: Partial<ProbeResult>): ProbeResult => ({ ok: true, running: 0, waitingUser: 0, threads: [], lastEndedAt: null, ...o });
  const waiting = (minutesAgo: number | null, id = "w"): ProbeThread => ({
    threadId: id,
    title: id,
    state: "waiting_user",
    pendingKind: "user_input",
    waitingSince: minutesAgo === null ? null : iso(minutesAgo),
  });

  it("no tasks and nothing ended recently: pause", () => {
    expect(pauseBlocker(probe({}), cfg, NOW)).toBeNull();
    expect(pauseBlocker(probe({ lastEndedAt: iso(10) }), cfg, NOW)).toBeNull();
  });

  it("task ended less than quietAfterEndMinutes ago: wait", () => {
    const b = pauseBlocker(probe({ lastEndedAt: iso(4) }), cfg, NOW);
    expect(b).toMatchObject({ kind: "just_ended", until: NOW + 6 * 60_000 });
    // 0 = 不等
    expect(pauseBlocker(probe({ lastEndedAt: iso(4) }), { ...cfg, quietAfterEndMinutes: 0 }, NOW)).toBeNull();
  });

  it("running tasks win over the quiet period", () => {
    expect(pauseBlocker(probe({ running: 1, lastEndedAt: iso(1) }), cfg, NOW)).toEqual({ kind: "running" });
  });

  it("waiting-user task under the grace period: wait; the latest one decides", () => {
    const b = pauseBlocker(probe({ waitingUser: 2, threads: [waiting(50, "old"), waiting(20, "new")] }), cfg, NOW);
    expect(b).toMatchObject({ kind: "waiting_user_recent", thread: { threadId: "new" }, until: NOW + 10 * 60_000 });
    expect(pauseBlocker(probe({ waitingUser: 1, threads: [waiting(30)] }), cfg, NOW)).toBeNull();
  });

  it("grace period does not apply when waiting-user tasks keep the machine busy", () => {
    expect(pauseBlocker(probe({ waitingUser: 1, threads: [waiting(50)] }), { ...cfg, waitingUserCountsAsBusy: true }, NOW)).toEqual({
      kind: "waiting_user",
    });
  });

  it("unknown waiting start does not block", () => {
    expect(pauseBlocker(probe({ waitingUser: 1, threads: [waiting(null)] }), cfg, NOW)).toBeNull();
  });

  it("grace and quiet period both apply", () => {
    // 等你回复已满，但另一个任务刚结束
    const b = pauseBlocker(probe({ waitingUser: 1, threads: [waiting(40)], lastEndedAt: iso(2) }), cfg, NOW);
    expect(b).toMatchObject({ kind: "just_ended" });
  });
});

describe("scheduled wake", () => {
  // 2026-11-12 是周四，11-14 周六，11-16 周一
  it("weekday", () => {
    expect(isoWeekday(2026, 11, 12)).toBe(4);
    expect(isoWeekday(2026, 11, 15)).toBe(7);
  });

  it("defaults: enabled, weekdays 08:30", () => {
    expect(DEFAULT_CONFIG).toMatchObject({ wakeEnabled: true, wakeTime: "08:30", wakeDays: [1, 2, 3, 4, 5] });
  });

  it("fires at wake time on a selected day, once per day key", () => {
    expect(planWake(at(12, 8, 30), cfg())).toBe("2026-11-12");
    expect(planWake(at(12, 8, 30) + WAKE_TRIGGER_WINDOW_MS - 1, cfg())).toBe("2026-11-12");
  });

  it("does not fire before, or after the short window (no catch-up)", () => {
    expect(planWake(at(12, 8, 29), cfg())).toBeNull();
    expect(planWake(at(12, 8, 30) + WAKE_TRIGGER_WINDOW_MS, cfg())).toBeNull();
    expect(planWake(at(12, 12), cfg())).toBeNull();
  });

  it("skips unselected days and disabled config", () => {
    expect(planWake(at(14, 8, 30), cfg())).toBeNull(); // 周六
    expect(planWake(at(14, 8, 30), cfg({ wakeDays: [6, 7] }))).toBe("2026-11-14");
    expect(planWake(at(12, 8, 30), cfg({ wakeEnabled: false }))).toBeNull();
    expect(planWake(at(12, 8, 30), cfg({ wakeDays: [] }))).toBeNull();
  });

  it("next wake skips the weekend", () => {
    expect(nextWeeklyAt(at(13, 9), "08:30", [1, 2, 3, 4, 5], TZ)).toBe(at(16, 8, 30)); // 周五 09:00 → 周一
    expect(nextWeeklyAt(at(12, 8), "08:30", [1, 2, 3, 4, 5], TZ)).toBe(at(12, 8, 30));
    expect(nextWeeklyAt(at(12, 8), "08:30", [], TZ)).toBeNull();
  });

  it("days label", () => {
    expect(daysLabel([1, 2, 3, 4, 5, 6, 7])).toBe("每天");
    expect(daysLabel([5, 4, 3, 2, 1])).toBe("工作日");
    expect(daysLabel([6, 7])).toBe("周末");
    expect(daysLabel([1, 3, 5])).toBe("周一、三、五");
  });
});

describe("skip this pause", () => {
  // 暂停时间 02:00，用来确认“这次”不依赖“今晚”的说法
  const c2 = cfg({ pauseTime: "02:00" });
  const ctx = (now: number) => {
    const cur = currentCycle(now, "02:00", TZ);
    const nextAt = nextPauseAt(now, "02:00", TZ);
    const next = { cycleDate: currentCycle(nextAt, "02:00", TZ).cycleDate, startAt: nextAt };
    return { now, config: c2, cur, next, afterNext: nextPauseAt(nextAt, "02:00", TZ) };
  };
  const run = (cycleDate: string, over: Partial<NightlyRun>): NightlyRun => ({
    cycleDate, status: "done", result: null, startedAt: 0, deadlineAt: 0, lastCheckAt: null, finishedAt: 0, ...over,
  });

  it("at 23:00 the target is tomorrow 02:00, resuming the day after", () => {
    const s = skipState({ ...ctx(at(12, 23)), runCur: null, runNext: null });
    expect(s.skip).toBeNull();
    expect(s.target).toMatchObject({ cycleDate: "2026-11-13", at: at(13, 2), resumeAt: at(14, 2), waiting: false });
  });

  it("at 01:00 the target is 02:00 the same day", () => {
    expect(skipState({ ...ctx(at(13, 1)), runCur: null, runNext: null }).target).toMatchObject({ cycleDate: "2026-11-13", at: at(13, 2) });
  });

  it("while waiting, the target is the current one", () => {
    const x = ctx(at(13, 3));
    const s = skipState({ ...x, runCur: run("2026-11-13", { status: "waiting" }), runNext: null });
    expect(s.target).toMatchObject({ cycleDate: "2026-11-13", at: at(13, 2), resumeAt: at(14, 2), waiting: true });
  });

  it("a skipped upcoming pause shows the banner and hides the button", () => {
    const x = ctx(at(12, 23));
    const s = skipState({ ...x, runCur: null, runNext: run("2026-11-13", { result: "skipped" }) });
    expect(s.target).toBeNull();
    expect(s.skip).toMatchObject({ cycleDate: "2026-11-13", resumeAt: at(14, 2) });
  });

  it("a skipped current pause shows until its wait window ends", () => {
    const skipped = run("2026-11-13", { result: "skipped" });
    expect(skipState({ ...ctx(at(13, 5)), runCur: skipped, runNext: null }).skip).toMatchObject({ cycleDate: "2026-11-13", resumeAt: at(14, 2) });
    // 02:00 + 8 小时 = 10:00 之后不再显示，可以跳过下一次
    const after = skipState({ ...ctx(at(13, 10)), runCur: skipped, runNext: null });
    expect(after.skip).toBeNull();
    expect(after.target).toMatchObject({ cycleDate: "2026-11-14" });
  });

  it("right after undo (no record yet, inside the window) the target stays the current one", () => {
    expect(skipState({ ...ctx(at(13, 5)), runCur: null, runNext: null }).target).toMatchObject({ cycleDate: "2026-11-13", waiting: false });
  });

  it("nothing when scheduled pause is off", () => {
    expect(skipState({ ...ctx(at(12, 23)), config: cfg({ pauseTime: "02:00", enabled: false }), runCur: null, runNext: null })).toEqual({ skip: null, target: null });
  });

  it("a skipped run makes planTick idle", () => {
    const cycle = currentCycle(at(13, 2), "02:00", TZ);
    expect(planTick({ now: at(13, 2), config: c2, cycle, run: run("2026-11-13", { result: "skipped" }), live: running })).toEqual({ kind: "idle" });
  });
});
