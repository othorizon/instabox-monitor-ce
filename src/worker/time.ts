// 时区相关的纯函数（不依赖 DST 固定偏移，用 Intl 计算）

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** 时区在该时刻相对 UTC 的偏移（毫秒） */
function offsetAt(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** 本地墙上时间 → epoch ms */
export function zonedToEpoch(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetAt(guess, tz);
  // 跨 DST 边界时再校正一次
  t = guess - offsetAt(t, tz);
  return t;
}

export function parseHHMM(s: string): { hh: number; mm: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 某个本地日期偏移 n 天后的日期（用 UTC 日历算，不受时区影响） */
function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export interface Cycle {
  /** 暂停时间点所在的本地日期，作为当晚周期的 key */
  cycleDate: string;
  /** 本周期的暂停时间点 */
  startAt: number;
}

/** 不晚于 now 的最近一次暂停时间点 */
export function currentCycle(now: number, pauseTime: string, tz: string): Cycle {
  const t = parseHHMM(pauseTime) ?? { hh: 22, mm: 0 };
  const p = localParts(now, tz);
  let day = { y: p.year, m: p.month, d: p.day };
  let start = zonedToEpoch(day.y, day.m, day.d, t.hh, t.mm, tz);
  if (start > now) {
    day = addDays(day.y, day.m, day.d, -1);
    start = zonedToEpoch(day.y, day.m, day.d, t.hh, t.mm, tz);
  }
  return { cycleDate: ymd(day.y, day.m, day.d), startAt: start };
}

/** 晚于 now 的下一次暂停时间点 */
export function nextPauseAt(now: number, pauseTime: string, tz: string): number {
  const cur = currentCycle(now, pauseTime, tz);
  const [y, m, d] = cur.cycleDate.split("-").map(Number) as [number, number, number];
  const next = addDays(y, m, d, 1);
  const t = parseHHMM(pauseTime) ?? { hh: 22, mm: 0 };
  return zonedToEpoch(next.y, next.m, next.d, t.hh, t.mm, tz);
}

/** 本地日期的 ISO 星期：1 = 周一 … 7 = 周日 */
export function isoWeekday(y: number, m: number, d: number): number {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** 今天（本地日期）的某个时间点，以及今天的日期和星期 */
export function todayAt(now: number, hhmm: string, tz: string) {
  const t = parseHHMM(hhmm) ?? { hh: 8, mm: 30 };
  const p = localParts(now, tz);
  return {
    date: ymd(p.year, p.month, p.day),
    weekday: isoWeekday(p.year, p.month, p.day),
    at: zonedToEpoch(p.year, p.month, p.day, t.hh, t.mm, tz),
  };
}

/** 晚于 now、且落在 days 中某一天的下一个 hhmm 时间点；days 为空返回 null */
export function nextWeeklyAt(now: number, hhmm: string, days: number[], tz: string): number | null {
  if (!days.length) return null;
  const t = parseHHMM(hhmm) ?? { hh: 8, mm: 30 };
  const p = localParts(now, tz);
  for (let i = 0; i <= 7; i++) {
    const d = addDays(p.year, p.month, p.day, i);
    if (!days.includes(isoWeekday(d.y, d.m, d.d))) continue;
    const at = zonedToEpoch(d.y, d.m, d.d, t.hh, t.mm, tz);
    if (at > now) return at;
  }
  return null;
}

/** “11月13日 02:00”，用于活动记录 */
export function formatMonthDayTime(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);
}
