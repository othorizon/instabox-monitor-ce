// 前后端共用的类型

export type MachineState =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "suspending"
  | "suspended"
  | "resuming"
  | "deleting"
  | "deleted"
  | "error";

export interface ScheduleConfig {
  enabled: boolean;
  /** 本地时间 HH:MM */
  pauseTime: string;
  timezone: string;
  waitForT3: boolean;
  /** 等你回复（批准/回答问题）的任务是否也算运行中 */
  waitingUserCountsAsBusy: boolean;
  maxWaitMinutes: number;
  onTimeout: "force" | "give_up";
  /** 高级：最后一个 t3 任务结束后至少再等多久才暂停（分钟，0 = 不等） */
  quietAfterEndMinutes: number;
  /** 高级：等你回复按空闲处理时，任务至少要等你这么久才算空闲（分钟，0 = 不等） */
  waitingUserGraceMinutes: number;
  /** 定时唤醒 */
  wakeEnabled: boolean;
  /** 本地时间 HH:MM */
  wakeTime: string;
  /** ISO 星期，1 = 周一 … 7 = 周日 */
  wakeDays: number[];
}

export const DEFAULT_CONFIG: ScheduleConfig = {
  enabled: true,
  pauseTime: "22:00",
  timezone: "Asia/Shanghai",
  waitForT3: true,
  waitingUserCountsAsBusy: false,
  maxWaitMinutes: 480,
  onTimeout: "give_up",
  quietAfterEndMinutes: 10,
  waitingUserGraceMinutes: 30,
  wakeEnabled: true,
  wakeTime: "08:30",
  wakeDays: [1, 2, 3, 4, 5],
};

export interface ProbeThread {
  threadId: string;
  title: string;
  /** running：agent 在跑；waiting_user：停下来等你批准或回答 */
  state: "running" | "waiting_user";
  pendingKind?: string | null;
  /** 这一轮 run 开始的时间（ISO） */
  since?: string | null;
  /** waiting_user：开始等你的时间（ISO） */
  waitingSince?: string | null;
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
  running: number;
  waitingUser: number;
  threads: ProbeThread[];
  /** 最近一次 t3 任务结束的时间（ISO），没有则为 null */
  lastEndedAt?: string | null;
}

export type RunResult =
  | "paused"
  | "forced"
  | "gave_up"
  | "already_paused"
  | "manual"
  | "cancelled"
  /** 定时唤醒时间到了，结束本周期的定时暂停 */
  | "woken"
  /** 你选择了跳过这一次 */
  | "skipped"
  | "error";

export interface NightlyRun {
  cycleDate: string;
  status: "waiting" | "done";
  result: RunResult | null;
  startedAt: number;
  deadlineAt: number;
  lastCheckAt: number | null;
  finishedAt: number | null;
}

export type WakeResult = "woken" | "already_running" | "cooldown" | "skipped" | "error";

export interface WakeRun {
  wakeDate: string;
  result: WakeResult | null;
  ts: number;
}

/** 某一次定时暂停 */
export interface SkipInfo {
  /** 这次暂停的周期 key（暂停时间点的本地日期） */
  cycleDate: string;
  /** 这次暂停的时间点 */
  at: number;
  /** 跳过后下一次照常暂停的时间点 */
  resumeAt: number;
  /** 这次暂停正在等 t3 任务 */
  waiting: boolean;
}

export interface MachineLive {
  state: MachineState | "unknown";
  runStartedAt?: string | null;
  cooldownUntil?: string | null;
  error?: string;
}

export interface MachineOverview {
  id: string;
  name: string;
  live: MachineLive;
  lastStateAt: number | null;
  config: ScheduleConfig;
  /** 当前（或最近一次）周期的执行记录 */
  run: NightlyRun | null;
  /** 下一次定时暂停的时间（epoch ms），未开启则为 null */
  nextPauseAt: number | null;
  /** 已跳过的那一次定时暂停（显示提示条和撤销），没有则为 null */
  skip: SkipInfo | null;
  /** “跳过这次”会跳过的那一次；已跳过或未开启定时暂停时为 null */
  skipTarget: SkipInfo | null;
  /** 最近一次定时唤醒 */
  wakeRun: WakeRun | null;
  /** 下一次定时唤醒的时间（epoch ms），未开启则为 null */
  nextWakeAt: number | null;
  probe: ProbeResult | null;
  probeAt: number | null;
}

export interface ActivityEvent {
  id: number;
  machineId: string | null;
  ts: number;
  type: string;
  source: "user" | "schedule" | "external" | "system";
  message: string;
}

export interface InstaboxMachineSummary {
  id: string;
  name: string;
  state: MachineState;
  monitored: boolean;
}
