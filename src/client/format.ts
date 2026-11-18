export { daysLabel, formatDuration, STATE_LABEL } from "../shared/labels";
import { formatDuration } from "../shared/labels";

const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function dayKey(ts: number, tz = viewerTz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}

export function clock(ts: number, tz = viewerTz) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);
}

/** “今天 22:00” / “明天 06:00” / “11月14日 22:00” */
export function dayClock(ts: number, now = Date.now(), tz = viewerTz) {
  const k = dayKey(ts, tz);
  const rel = [
    [dayKey(now, tz), "今天"],
    [dayKey(now + 86400_000, tz), "明天"],
    [dayKey(now + 2 * 86400_000, tz), "后天"],
    [dayKey(now - 86400_000, tz), "昨天"],
  ].find(([key]) => key === k)?.[1];
  const day = rel ?? new Intl.DateTimeFormat("zh-CN", { timeZone: tz, month: "numeric", day: "numeric" }).format(ts);
  return `${day} ${clock(ts, tz)}`;
}

export function dayHeading(ts: number, now = Date.now(), tz = viewerTz) {
  const k = dayKey(ts, tz);
  if (k === dayKey(now, tz)) return "今天";
  if (k === dayKey(now - 86400_000, tz)) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, month: "long", day: "numeric", weekday: "short" }).format(ts);
}

export function groupByDay<T extends { ts: number }>(items: T[], tz = viewerTz): { key: string; ts: number; items: T[] }[] {
  const groups: { key: string; ts: number; items: T[] }[] = [];
  for (const it of items) {
    const k = dayKey(it.ts, tz);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(it);
    else groups.push({ key: k, ts: it.ts, items: [it] });
  }
  return groups;
}

export function ago(ts: number, now = Date.now()) {
  const d = now - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return dayClock(ts, now);
}

export function shortDuration(ms: number) {
  return formatDuration(ms).replace(/ /g, "").replace("小时", "h").replace("分钟", "m");
}
