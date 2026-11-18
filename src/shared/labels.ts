import type { MachineState } from "./types";

export const STATE_LABEL: Record<MachineState | "unknown", string> = {
  creating: "创建中",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  suspending: "暂停中",
  suspended: "已暂停",
  resuming: "唤醒中",
  deleting: "删除中",
  deleted: "已删除",
  error: "出错",
  unknown: "未知",
};

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

const WEEKDAY = ["", "一", "二", "三", "四", "五", "六", "日"];

/** [1..7] → 每天，[1..5] → 工作日，[6,7] → 周末，其他 → 周一、三、五 */
export function daysLabel(days: number[]): string {
  const key = [...days].sort().join(",");
  if (key === "1,2,3,4,5,6,7") return "每天";
  if (key === "1,2,3,4,5") return "工作日";
  if (key === "6,7") return "周末";
  if (!days.length) return "不重复";
  return "周" + [...days].sort().map((d) => WEEKDAY[d]).join("、");
}

/** 某个时区下的 HH:MM */
export function hhmm(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);
}

/** 标题过长时截断 */
export function shortTitle(title: string, max = 24): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title;
}
