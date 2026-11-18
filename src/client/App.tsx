import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiClient } from "./api";
import { useEvents } from "./useEvents";
import { STATE_LABEL, ago, clock, dayClock, dayHeading, daysLabel, formatDuration, groupByDay } from "./format";
import { DEFAULT_CONFIG, type ActivityEvent, type InstaboxMachineSummary, type MachineOverview, type ScheduleConfig, type ProbeResult } from "../shared/types";
import { pauseBlocker, pendingLabel } from "../shared/pauseGate";

const TRANSITIONAL = new Set(["creating", "starting", "stopping", "suspending", "resuming", "deleting"]);
const SELECTED_KEY = "ibm.selected";

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}
function writeSelected(id: string) {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // 忽略
  }
}

export function App() {
  const [machines, setMachines] = useState<MachineOverview[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean; action?: { label: string; run: () => void } } | null>(null);
  const [sheet, setSheet] = useState<null | "config" | "add" | "confirm-pause" | "confirm-skip" | "confirm-disable-pause" | "switch">(null);
  const [busy, setBusy] = useState<null | "pause" | "wake">(null);
  const fastPollUntil = useRef(0);

  const selected = useMemo(() => {
    if (!machines?.length) return null;
    return machines.find((m) => m.id === selectedId) ?? machines[0]!;
  }, [machines, selectedId]);
  // 撤销等延后执行的操作要用最新的数据
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const showToast = useCallback((text: string, error = false, action?: { label: string; run: () => void }) => {
    const next = { text, error, action };
    setToast(next);
    window.setTimeout(() => setToast((t) => (t === next ? null : t)), error || action ? 6000 : 3000);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.overview();
      setMachines(r.machines);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  const activity = useEvents(selected?.id);
  const refreshEvents = activity.refresh;

  const replaceMachine = (m: MachineOverview) => setMachines((list) => (list ? list.map((x) => (x.id === m.id ? m : x)) : [m]));

  useEffect(() => {
    void load();
  }, [load]);

  // 轮询：平时 20 秒，操作后（或处于过渡态时）3 秒
  useEffect(() => {
    let timer: number;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        await load();
        void refreshEvents();
      }
      const fast = Date.now() < fastPollUntil.current || (selected && TRANSITIONAL.has(selected.live.state));
      timer = window.setTimeout(tick, fast ? 3000 : 20000);
    };
    timer = window.setTimeout(tick, Date.now() < fastPollUntil.current ? 3000 : 20000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, refreshEvents, selected?.id, selected?.live.state]);

  const doAction = async (kind: "pause" | "wake") => {
    if (!selected) return;
    setSheet(null);
    setBusy(kind);
    try {
      const m = kind === "pause" ? await apiClient.pause(selected.id) : await apiClient.wake(selected.id);
      replaceMachine(m);
      fastPollUntil.current = Date.now() + 90_000;
      showToast(kind === "pause" ? "已发送暂停请求" : "已发送唤醒请求");
      void refreshEvents();
    } catch (e) {
      showToast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const skipPause = async () => {
    if (!selected?.skipTarget) return;
    setSheet(null);
    try {
      replaceMachine(await apiClient.skipPause(selected.id, selected.skipTarget.cycleDate));
      showToast("已跳过这次定时暂停");
      void refreshEvents();
    } catch (e) {
      showToast((e as Error).message, true);
    }
  };

  const undoSkip = async () => {
    if (!selected?.skip) return;
    try {
      replaceMachine(await apiClient.unskipPause(selected.id, selected.skip.cycleDate));
      showToast("已撤销跳过");
      void refreshEvents();
    } catch (e) {
      showToast((e as Error).message, true);
    }
  };

  /** 首页快捷开关：立即保存，可撤销 */
  const setScheduleSwitch = async (field: "enabled" | "wakeEnabled", value: boolean, isUndo = false) => {
    const before = selectedRef.current;
    if (!before) return;
    setSheet(null);
    replaceMachine({ ...before, config: { ...before.config, [field]: value } }); // 先更新界面
    try {
      const m = await apiClient.saveConfig(before.id, { ...before.config, [field]: value });
      replaceMachine(m);
      void refreshEvents();
      const name = field === "enabled" ? "定时暂停" : "定时唤醒";
      let text = `已${value ? "开启" : "关闭"}${name}`;
      const t = m.skipTarget;
      if (field === "enabled" && value && t && t.at <= Date.now()) text += `，${dayClock(t.at, Date.now(), m.config.timezone)} 这次马上开始`;
      showToast(isUndo ? `已撤销，${name}${value ? "已开启" : "已关闭"}` : text, false, isUndo ? undefined : { label: "撤销", run: () => void setScheduleSwitch(field, !value, true) });
    } catch (e) {
      replaceMachine(before);
      showToast((e as Error).message, true);
    }
  };

  const onScheduleSwitch = (field: "enabled" | "wakeEnabled", value: boolean) => {
    // 关闭定时暂停会结束正在进行的等待，先确认
    if (field === "enabled" && !value && selected?.run?.status === "waiting") setSheet("confirm-disable-pause");
    else void setScheduleSwitch(field, value);
  };

  if (machines === null) {
    return (
      <Shell>
        {loadError ? <ErrorBlock message={loadError} onRetry={load} /> : <div className="skeleton" aria-busy="true" />}
      </Shell>
    );
  }

  return (
    <Shell
      header={
        <header className="topbar">
          {selected ? (
            <button className="machine-switch" onClick={() => setSheet("switch")} aria-label="切换机器">
              <span className="machine-name">{selected.name}</span>
              <span className="chev" aria-hidden>
                ▾
              </span>
            </button>
          ) : (
            <span className="machine-name">Instabox 监管</span>
          )}
          <button className="icon-btn" onClick={() => setSheet("add")} aria-label="添加机器">
            ＋
          </button>
        </header>
      }
    >
      {loadError && <div className="banner error">{loadError}</div>}

      {!selected ? (
        <section className="card empty">
          <p>还没有监管任何机器。</p>
          <button className="btn primary" onClick={() => setSheet("add")}>
            添加机器
          </button>
        </section>
      ) : (
        <>
          <StatusCard
            m={selected}
            busy={busy}
            onPause={() => setSheet("confirm-pause")}
            onWake={() => doAction("wake")}
            onProbed={(probe, probeAt) => replaceMachine({ ...selected, probe, probeAt })}
            onError={(msg) => showToast(msg, true)}
          />
          <ScheduleCard
            m={selected}
            onEdit={() => setSheet("config")}
            onSkip={() => setSheet("confirm-skip")}
            onUndoSkip={undoSkip}
            onSwitch={onScheduleSwitch}
          />
          <ActivityCard key={selected.id} {...activity} tz={selected.config.timezone} />
        </>
      )}

      {sheet === "confirm-pause" && selected && (
        <Sheet title={`暂停 ${selected.name}？`} onClose={() => setSheet(null)}>
          <ConfirmPause m={selected} onConfirm={() => doAction("pause")} onCancel={() => setSheet(null)} />
        </Sheet>
      )}
      {sheet === "confirm-skip" && selected?.skipTarget && (
        <Sheet title={`跳过 ${dayClock(selected.skipTarget.at, Date.now(), selected.config.timezone)} 的暂停？`} onClose={() => setSheet(null)}>
          <ConfirmSkip m={selected} onConfirm={skipPause} onCancel={() => setSheet(null)} />
        </Sheet>
      )}
      {sheet === "confirm-disable-pause" && selected && (
        <Sheet title="关闭定时暂停？" onClose={() => setSheet(null)}>
          <div className="confirm">
            <p>正在等 t3 任务结束后暂停 {selected.name}。关闭后这次等待也会结束，机器会一直运行。</p>
            <div className="row-btns">
              <button className="btn" onClick={() => setSheet(null)}>
                取消
              </button>
              <button className="btn warn" onClick={() => void setScheduleSwitch("enabled", false)}>
                关闭定时暂停
              </button>
            </div>
          </div>
        </Sheet>
      )}
      {sheet === "config" && selected && (
        <ConfigSheet
          m={selected}
          onClose={() => setSheet(null)}
          onSaved={(m) => {
            replaceMachine(m);
            setSheet(null);
            showToast("已保存");
            void refreshEvents();
          }}
          onRemoved={() => {
            setSheet(null);
            setSelectedId(null);
            void load();
            showToast("已停止监管");
          }}
          onError={(msg) => showToast(msg, true)}
        />
      )}
      {sheet === "add" && (
        <Sheet title="添加要监管的机器" onClose={() => setSheet(null)}>
          <AddMachine
            onAdded={(m) => {
              setMachines((list) => [...(list ?? []).filter((x) => x.id !== m.id), m]);
              setSelectedId(m.id);
              writeSelected(m.id);
              setSheet(null);
              showToast(`已添加 ${m.name}`);
            }}
            onError={(msg) => showToast(msg, true)}
          />
        </Sheet>
      )}
      {sheet === "switch" && (
        <Sheet title="切换机器" onClose={() => setSheet(null)}>
          <ul className="pick-list">
            {machines.map((m) => (
              <li key={m.id}>
                <button
                  className={`pick ${m.id === selected?.id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedId(m.id);
                    writeSelected(m.id);
                    setSheet(null);
                  }}
                >
                  <StateDot state={m.live.state} />
                  <span className="pick-name">{m.name}</span>
                  <span className="muted">{STATE_LABEL[m.live.state]}</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="btn ghost full" onClick={() => setSheet("add")}>
            ＋ 添加机器
          </button>
        </Sheet>
      )}

      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                const run = toast.action!.run;
                setToast(null);
                run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </Shell>
  );
}

function Shell({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="app">
      {header}
      <main>{children}</main>
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="card">
      <p className="error-text">{message}</p>
      <button className="btn" onClick={onRetry}>
        重试
      </button>
    </section>
  );
}

function StateDot({ state }: { state: string }) {
  const tone =
    state === "running" ? "ok" : state === "suspended" || state === "stopped" ? "idle" : TRANSITIONAL.has(state) ? "pending" : "bad";
  return <span className={`dot ${tone}`} aria-hidden />;
}

// ---------- 状态卡片 ----------

function StatusCard(props: {
  m: MachineOverview;
  busy: null | "pause" | "wake";
  onPause: () => void;
  onWake: () => void;
  onProbed: (p: ProbeResult, at: number) => void;
  onError: (msg: string) => void;
}) {
  const { m, busy } = props;
  const s = m.live.state;
  const now = Date.now();
  const cooldown = m.live.cooldownUntil && Date.parse(m.live.cooldownUntil) > now ? Date.parse(m.live.cooldownUntil) : null;

  let sub: string | null = null;
  if (s === "running" && m.live.runStartedAt) sub = `已运行 ${formatDuration(now - Date.parse(m.live.runStartedAt))}`;
  else if ((s === "suspended" || s === "stopped") && m.lastStateAt) sub = `${dayClock(m.lastStateAt)} 起`;

  let action: ReactNode;
  if (s === "running") {
    action = (
      <button className="btn big danger" disabled={!!busy} onClick={props.onPause}>
        {busy === "pause" ? "暂停中…" : "暂停"}
      </button>
    );
  } else if (s === "suspended" || s === "stopped") {
    action = (
      <button className="btn big primary" disabled={!!busy || !!cooldown} onClick={props.onWake}>
        {busy === "wake" ? "唤醒中…" : cooldown ? `冷却中，${clock(cooldown)} 后可唤醒` : s === "stopped" ? "启动" : "唤醒"}
      </button>
    );
  } else {
    action = (
      <button className="btn big" disabled>
        {STATE_LABEL[s]}…
      </button>
    );
  }

  return (
    <section className="card status">
      <div className="status-head">
        <StateDot state={s} />
        <div>
          <div className="state-label">{STATE_LABEL[s]}</div>
          {sub && <div className="muted small">{sub}</div>}
        </div>
      </div>
      {m.live.error && <div className="banner error">{m.live.error}</div>}
      <T3Row m={m} onProbed={props.onProbed} onError={props.onError} />
      {action}
    </section>
  );
}

function T3Row({ m, onProbed, onError }: { m: MachineOverview; onProbed: (p: ProbeResult, at: number) => void; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const p = m.probe;
  const canRefresh = m.live.state === "running";

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await apiClient.probe(m.id);
      onProbed(r.probe, r.probeAt);
      setOpen(true);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  let summary: ReactNode;
  if (!p) summary = <span className="muted">尚未检测</span>;
  else if (!p.ok) summary = <span className="warn-text">检测失败</span>;
  else if (!p.running && !p.waitingUser) summary = <span>没有进行中的任务</span>;
  else
    summary = (
      <span>
        {p.running > 0 && <b>{p.running} 个运行中</b>}
        {p.running > 0 && p.waitingUser > 0 && " · "}
        {p.waitingUser > 0 && <span className="warn-text">{p.waitingUser} 个等你回复</span>}
      </span>
    );

  const hasDetail = p && (!p.ok || p.threads.length > 0);

  return (
    <div className="t3">
      <div className="t3-row">
        <button className="t3-summary" onClick={() => hasDetail && setOpen((o) => !o)} aria-expanded={open} disabled={!hasDetail}>
          <span className="t3-label">t3</span>
          {summary}
          {m.probeAt && <span className="muted small"> · {ago(m.probeAt)}</span>}
          {hasDetail && <span className="chev small">{open ? "▴" : "▾"}</span>}
        </button>
        {canRefresh && (
          <button className="icon-btn small" onClick={refresh} disabled={loading} aria-label="刷新 t3 任务" title="刷新（会重置机器的空闲计时）">
            <span className={loading ? "spin" : ""}>↻</span>
          </button>
        )}
      </div>
      {open && p && (
        <ul className="threads">
          {!p.ok && <li className="error-text small">{p.error}</li>}
          {p.threads.map((t) => (
            <li key={t.threadId}>
              <span className={`tag ${t.state === "running" ? "ok" : "warn"}`}>{t.state === "running" ? "运行中" : pendingLabel(t.pendingKind)}</span>
              <span className="thread-title">{t.title || t.threadId.slice(0, 8)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfirmPause({ m, onConfirm, onCancel }: { m: MachineOverview; onConfirm: () => void; onCancel: () => void }) {
  const p = m.probe;
  return (
    <div className="confirm">
      <p>暂停会冻结机器上的所有进程，唤醒后从原处继续，内存和文件都保留。</p>
      {p?.ok && (p.running > 0 || p.waitingUser > 0) && (
        <p className="warn-text">
          t3 {p.running > 0 ? `有 ${p.running} 个任务正在运行` : ""}
          {p.running > 0 && p.waitingUser > 0 ? "，" : ""}
          {p.waitingUser > 0 ? `${p.waitingUser} 个在等你回复` : ""}（{ago(m.probeAt!)}检测）。
        </p>
      )}
      <div className="row-btns">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button className="btn danger" onClick={onConfirm} autoFocus>
          确认暂停
        </button>
      </div>
    </div>
  );
}

// ---------- 定时计划卡片 ----------

function runLine(m: MachineOverview): { text: string; tone?: "ok" | "warn" | "bad" } | null {
  const r = m.run;
  if (!r) return null;
  const now = Date.now();
  const tz = m.config.timezone;
  if (r.status === "waiting") {
    const p = m.probe;
    // 上一次检查是因为“刚结束 / 刚开始等你”才没暂停：说明最早什么时候暂停
    const b = p && m.probeAt ? pauseBlocker(p, m.config, m.probeAt) : null;
    if (b?.kind === "just_ended") {
      return {
        text: `t3 任务 ${clock(b.endedAt, tz)} 结束，满 ${m.config.quietAfterEndMinutes} 分钟后的下一次检查时暂停（最早 ${clock(b.until, tz)}）`,
        tone: "warn",
      };
    }
    if (b?.kind === "waiting_user_recent") {
      const title = b.thread.title || b.thread.threadId.slice(0, 8);
      return {
        text: `“${title}” ${clock(b.since, tz)} 起${pendingLabel(b.thread.pendingKind)}，满 ${m.config.waitingUserGraceMinutes} 分钟后的下一次检查时暂停（最早 ${clock(b.until, tz)}）`,
        tone: "warn",
      };
    }
    const what = p?.ok ? `${p.running} 个运行中${p.waitingUser ? `、${p.waitingUser} 个等你回复` : ""}` : "检测失败";
    return {
      text: `正在等 t3 任务结束（${what}）。最晚等到 ${dayClock(r.deadlineAt, now, tz)}，之后${m.config.onTimeout === "force" ? "强制暂停" : "放弃本次暂停"}`,
      tone: "warn",
    };
  }
  // 只展示最近 18 小时内结束的记录，避免把很久以前的结果当作“今晚”
  if (!r.finishedAt || now - r.finishedAt > 18 * 3600_000) return null;
  const t = dayClock(r.finishedAt, now, tz);
  switch (r.result) {
    case "paused":
      return { text: `${t} 已定时暂停`, tone: "ok" };
    case "forced":
      return { text: `${t} 等待超时，已强制暂停`, tone: "ok" };
    case "gave_up":
      return { text: `${t} 等待超时，放弃了本次暂停`, tone: "warn" };
    case "already_paused":
      return { text: `${t} 机器已是暂停状态，无需操作` };
    case "manual":
      return { text: `${t} 你手动暂停了，定时暂停结束` };
    case "cancelled":
      return { text: `${t} 本次定时暂停已取消` };
    case "skipped":
      return null; // 由“已跳过”提示条展示
    case "woken":
      // 只有真正打断了等待的才显示；唤醒时补记的空记录不显示
      return r.lastCheckAt ? { text: `${t} 唤醒时间已到，结束了暂停等待` } : null;
    case "error":
      return { text: `${t} 定时暂停失败，详见活动记录`, tone: "bad" };
    default:
      return null;
  }
}

function wakeLine(m: MachineOverview): { text: string; tone?: "ok" | "warn" | "bad" } | null {
  const w = m.wakeRun;
  const now = Date.now();
  if (!w || !w.result || now - w.ts > 18 * 3600_000) return null;
  const t = dayClock(w.ts, now, m.config.timezone);
  switch (w.result) {
    case "skipped":
      return null; // 由“已跳过”提示条展示
    case "woken":
      return { text: `${t} 已定时唤醒`, tone: "ok" };
    case "already_running":
      return { text: `${t} 机器已在运行，无需唤醒` };
    case "skipped":
      return { text: `${t} 机器状态不适合唤醒，已跳过`, tone: "warn" };
    case "cooldown":
      return { text: `${t} 机器处于冷却期，没能唤醒`, tone: "bad" };
    case "error":
      return { text: `${t} 定时唤醒失败，详见活动记录`, tone: "bad" };
  }
}

function SkipIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="icon">
      <path d="M3 3.5v9l6-4.5z" fill="currentColor" />
      <rect x="10.5" y="3.5" width="2" height="9" rx="1" fill="currentColor" />
    </svg>
  );
}

function ConfirmSkip({ m, onConfirm, onCancel }: { m: MachineOverview; onConfirm: () => void; onCancel: () => void }) {
  const t = m.skipTarget!;
  const tz = m.config.timezone;
  const now = Date.now();
  return (
    <div className="confirm">
      <p>
        {t.waiting
          ? "不再等 t3 任务结束，这次定时暂停不再执行，机器会一直运行。"
          : `${dayClock(t.at, now, tz)} 不会自动暂停 ${m.name}，机器会一直运行。`}
      </p>
      <p className="muted small">
        {t.waiting ? "" : "只跳过这一次，"}
        {dayClock(t.resumeAt, now, tz)} 起照常定时暂停。定时唤醒不受影响。
      </p>
      <div className="row-btns">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button className="btn warn" onClick={onConfirm}>
          跳过这次
        </button>
      </div>
    </div>
  );
}

function ScheduleCard({
  m,
  onEdit,
  onSkip,
  onUndoSkip,
  onSwitch,
}: {
  m: MachineOverview;
  onEdit: () => void;
  onSkip: () => void;
  onUndoSkip: () => void;
  onSwitch: (field: "enabled" | "wakeEnabled", value: boolean) => void;
}) {
  const c = m.config;
  const pauseLine = runLine(m);
  const wLine = wakeLine(m);
  const now = Date.now();
  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          定时计划 {c.timezone !== viewerTz && <span className="muted small">（{c.timezone}）</span>}
        </h2>
        <button className="btn ghost small" onClick={onEdit}>
          编辑
        </button>
      </div>

      <div className="sched-row">
        <span className="sched-kind">暂停</span>
        <div className="sched-main-col">
          {!c.enabled ? (
            <p className="muted sched-off">已关闭 · 每天 {c.pauseTime}</p>
          ) : (
            <>
              <div className="sched-time">每天 {c.pauseTime}</div>
              <div className="chips">
                {c.waitForT3 ? (
                  <>
                    <span className="chip">等 t3 任务结束</span>
                    <span className="chip">最长 {formatDuration(c.maxWaitMinutes * 60_000)}</span>
                    <span className="chip">超时{c.onTimeout === "force" ? "强制暂停" : "放弃暂停"}</span>
                    <span className="chip">
                      {c.waitingUserCountsAsBusy
                        ? "等你回复的也继续等"
                        : c.waitingUserGraceMinutes
                          ? `等你回复的最多等 ${c.waitingUserGraceMinutes} 分钟`
                          : "等你回复的不等"}
                    </span>
                    {c.quietAfterEndMinutes !== DEFAULT_CONFIG.quietAfterEndMinutes && (
                      <span className="chip">{c.quietAfterEndMinutes ? `任务结束后再等 ${c.quietAfterEndMinutes} 分钟` : "任务结束就暂停"}</span>
                    )}
                  </>
                ) : (
                  <span className="chip">不等 t3，直接暂停</span>
                )}
              </div>
            </>
          )}
          {m.skip ? (
            <div className="skip-bar">
              <span>
                已跳过 {dayClock(m.skip.at, now, c.timezone)} 的暂停，{dayClock(m.skip.resumeAt, now, c.timezone)} 恢复
              </span>
              <button className="undo" onClick={onUndoSkip}>
                撤销
              </button>
            </div>
          ) : (
            <>
              {pauseLine && <p className={`run-line ${pauseLine.tone ?? ""}`}>{pauseLine.text}</p>}
              {c.enabled && (
                <div className="next-row">
                  <span className="muted small">{nextPauseText(m, now)}</span>
                  {m.skipTarget && (
                    <button className="btn-pill" onClick={onSkip}>
                      <SkipIcon />
                      跳过这次
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <Switch checked={c.enabled} onChange={(v) => onSwitch("enabled", v)} label="定时暂停" />
      </div>

      <div className="sched-row">
        <span className="sched-kind wake">唤醒</span>
        <div className="sched-main-col">
          {!c.wakeEnabled ? (
            <p className="muted sched-off">
              已关闭 · {daysLabel(c.wakeDays)} {c.wakeTime}
            </p>
          ) : (
            <div className="sched-time">
              {daysLabel(c.wakeDays)} {c.wakeTime}
            </div>
          )}
          {wLine && <p className={`run-line ${wLine.tone ?? ""}`}>{wLine.text}</p>}
          {c.wakeEnabled && m.nextWakeAt && <p className="muted small next">下次：{dayClock(m.nextWakeAt, now, c.timezone)}（{weekdayName(m.nextWakeAt, c.timezone)}）</p>}
        </div>
        <Switch checked={c.wakeEnabled} onChange={(v) => onSwitch("wakeEnabled", v)} label="定时唤醒" />
      </div>
    </section>
  );
}

/** “下次”这一行：始终显示“跳过这次”会作用的那一次，等待中则由上方的等待提示说明 */
function nextPauseText(m: MachineOverview, now: number): string {
  const t = m.skipTarget;
  const tz = m.config.timezone;
  if (t) {
    if (t.waiting) return "";
    return t.at <= now ? `${dayClock(t.at, now, tz)} 的暂停即将开始` : `下次：${dayClock(t.at, now, tz)}`;
  }
  return m.nextPauseAt ? `下次：${dayClock(m.nextPauseAt, now, tz)}` : "";
}

function weekdayName(ts: number, tz: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, weekday: "short" }).format(ts);
}

// ---------- 活动 ----------

const SOURCE_LABEL: Record<ActivityEvent["source"], string> = { user: "手动", schedule: "定时", external: "外部", system: "系统" };

function ActivityCard({
  events,
  hasMore,
  loadingMore,
  loadMore,
  tz,
}: {
  events: ActivityEvent[] | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  tz: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupByDay(events ?? [], tz), [events, tz]);

  // 滚到列表底部附近时自动加载更早的一页
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!hasMore || !root || !target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { root, rootMargin: "0px 0px 160px 0px" });
    io.observe(target);
    return () => io.disconnect();
  }, [hasMore, loadMore, events]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>最近 30 天活动</h2>
      </div>
      {events === null ? (
        <p className="muted">加载中…</p>
      ) : events.length === 0 ? (
        <p className="muted">暂无记录</p>
      ) : (
        <div className="events-scroll" ref={scrollRef}>
          {groups.map((g) => (
            <div key={g.key} className="day">
              <div className="day-head">{dayHeading(g.ts, Date.now(), tz)}</div>
              <ul className="events">
                {g.items.map((e) => (
                  <li key={e.id} className={`ev ${e.type === "error" || e.type === "probe_error" ? "bad" : ""}`}>
                    <span className="ev-time">{clock(e.ts, tz)}</span>
                    <span className={`src ${e.source}`}>{SOURCE_LABEL[e.source]}</span>
                    <span className="ev-msg">{e.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div ref={sentinelRef} className="events-foot">
            {loadingMore ? (
              <p className="muted small">加载中…</p>
            ) : hasMore ? (
              <button className="btn ghost full" onClick={loadMore}>
                加载更早的记录
              </button>
            ) : (
              <p className="muted small">没有更早的记录了（保留最近 30 天）</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- 弹出面板 ----------

function Sheet({
  title,
  onClose,
  onBack,
  grouped,
  children,
}: {
  title: string;
  onClose: () => void;
  /** 有值时是二级页面：左上角显示返回，Esc 也是返回 */
  onBack?: () => void;
  /** 分组列表样式（浅色底） */
  grouped?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (onBack ?? onClose)();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, onBack]);
  const body = useRef<HTMLDivElement>(null);
  // 换页回到顶部
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [title]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${grouped ? " grouped" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className={`sheet-head${onBack ? " with-back" : ""}`}>
          {onBack && (
            <button className="back-btn" onClick={onBack}>
              ‹ 返回
            </button>
          )}
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="sheet-body" ref={body}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** 一行开关：整行可点 */
function SwitchCell({ label, hint, checked, onChange, big }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; big?: boolean }) {
  return (
    <label className={`cell${big ? " big" : ""}`}>
      <span className="stack">
        <span className="lbl">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

type ConfigPage = "root" | "pause" | "wake";
const PAGE_TITLE: Record<ConfigPage, string> = { root: "定时计划设置", pause: "定时暂停", wake: "定时唤醒" };
const MAX_GRACE_MINUTES = 240;

/** 数字输入（分钟）：保留输入中的原始文本，校验交给调用方 */
function useMinutes(initial: number) {
  const [text, setText] = useState(String(initial));
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_GRACE_MINUTES;
  return { text, setText, value: n, valid };
}

function ConfigSheet({
  m,
  onClose,
  onSaved,
  onRemoved,
  onError,
}: {
  m: MachineOverview;
  onClose: () => void;
  onSaved: (m: MachineOverview) => void;
  onRemoved: () => void;
  onError: (msg: string) => void;
}) {
  const [page, setPage] = useState<ConfigPage>("root");
  const [c, setC] = useState<ScheduleConfig>(m.config);
  const [hours, setHours] = useState(String(Math.floor(m.config.maxWaitMinutes / 60)));
  const [minutes, setMinutes] = useState(String(m.config.maxWaitMinutes % 60));
  const quiet = useMinutes(m.config.quietAfterEndMinutes);
  const grace = useMinutes(m.config.waitingUserGraceMinutes);
  const [advOpen, setAdvOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [customDays, setCustomDays] = useState(() => !["1,2,3,4,5", "1,2,3,4,5,6,7"].includes(m.config.wakeDays.join(",")));
  const set = <K extends keyof ScheduleConfig>(k: K, v: ScheduleConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const zones = useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf("timeZone") as string[];
    } catch {
      return ["Asia/Shanghai"];
    }
  }, []);

  const maxWait = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  const maxWaitInvalid = hours.trim() === "" || maxWait < 5 || maxWait > 20 * 60;
  const waitsForT3 = c.enabled && c.waitForT3;
  const graceApplies = !c.waitingUserCountsAsBusy;
  const advInvalid = waitsForT3 && (!quiet.valid || (graceApplies && !grace.valid));
  const pauseInvalid = (waitsForT3 && maxWaitInvalid) || advInvalid;
  const wakeInvalid = c.wakeEnabled && c.wakeDays.length === 0;

  // 页面上正在编辑的完整配置（隐藏的输入保留原值）
  const draft: ScheduleConfig = {
    ...c,
    maxWaitMinutes: waitsForT3 && !maxWaitInvalid ? maxWait : m.config.maxWaitMinutes,
    quietAfterEndMinutes: quiet.valid ? quiet.value : m.config.quietAfterEndMinutes,
    waitingUserGraceMinutes: grace.valid ? grace.value : m.config.waitingUserGraceMinutes,
  };

  const daysKey = [...c.wakeDays].sort().join(",");
  const repeatMode = customDays ? "custom" : daysKey === "1,2,3,4,5,6,7" ? "daily" : daysKey === "1,2,3,4,5" ? "workdays" : "custom";
  const setRepeat = (mode: "daily" | "workdays" | "custom") => {
    if (mode === "daily") set("wakeDays", [1, 2, 3, 4, 5, 6, 7]);
    if (mode === "workdays") set("wakeDays", [1, 2, 3, 4, 5]);
    setCustomDays(mode === "custom");
  };
  const toggleDay = (d: number) => {
    setCustomDays(true);
    set("wakeDays", c.wakeDays.includes(d) ? c.wakeDays.filter((x) => x !== d) : [...c.wakeDays, d].sort());
  };

  const save = async () => {
    if (pauseInvalid || wakeInvalid) {
      // 跳到出错的那一页
      if (pauseInvalid) {
        setPage("pause");
        if (advInvalid) setAdvOpen(true);
      } else setPage("wake");
      return;
    }
    setSaving(true);
    try {
      onSaved(await apiClient.saveConfig(m.id, draft));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await apiClient.removeMachine(m.id);
      onRemoved();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const advNonDefault = advancedChanges(draft);

  return (
    <Sheet title={PAGE_TITLE[page]} onClose={onClose} onBack={page === "root" ? undefined : () => setPage("root")} grouped>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {page === "root" && (
          <>
            <div className="sec">定时</div>
            <div className="list">
              <button type="button" className="cell nav big" onClick={() => setPage("pause")}>
                <span className="stack">
                  <span className="lbl">定时暂停</span>
                  <span className={`hint${pauseInvalid ? " error-text" : ""}`}>{pauseInvalid ? "有设置需要修改" : pauseSummary(draft)}</span>
                </span>
                <span className="go" aria-hidden>
                  ›
                </span>
              </button>
              <button type="button" className="cell nav big" onClick={() => setPage("wake")}>
                <span className="stack">
                  <span className="lbl">定时唤醒</span>
                  <span className={`hint${wakeInvalid ? " error-text" : ""}`}>{wakeInvalid ? "至少选择一天" : wakeSummary(draft)}</span>
                </span>
                <span className="go" aria-hidden>
                  ›
                </span>
              </button>
            </div>

            <div className="sec">通用</div>
            <div className="list">
              <label className="cell">
                <span className="lbl">时区</span>
                <input className="inline-input tz" list="tz-list" value={c.timezone} onChange={(e) => set("timezone", e.target.value)} required />
                <datalist id="tz-list">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </label>
            </div>
            <p className="note">暂停和唤醒共用这个时区</p>
          </>
        )}

        {page === "pause" && (
          <>
            <div className="list">
              <SwitchCell big label="每天定时暂停" checked={c.enabled} onChange={(v) => set("enabled", v)} />
              {c.enabled && (
                <label className="cell">
                  <span className="lbl">暂停时间</span>
                  <input className="inline-input" type="time" required value={c.pauseTime} onChange={(e) => set("pauseTime", e.target.value)} />
                </label>
              )}
            </div>

            {c.enabled && (
              <>
                <div className="sec">等 t3 任务</div>
                <div className="list">
                  <SwitchCell
                    label="等任务结束再暂停"
                    hint="到点还有任务在跑，每 5 分钟查一次，结束后再暂停"
                    checked={c.waitForT3}
                    onChange={(v) => set("waitForT3", v)}
                  />
                  {c.waitForT3 && (
                    <div className="cell col">
                      <span className="stack">
                        <span className="lbl">等你回复的任务</span>
                        <span className="hint">任务停下来等你批准或回答时</span>
                      </span>
                      <Segmented
                        value={c.waitingUserCountsAsBusy ? "wait" : "idle"}
                        options={[
                          ["wait", "继续等"],
                          ["idle", "按空闲处理"],
                        ]}
                        onChange={(v) => set("waitingUserCountsAsBusy", v === "wait")}
                      />
                      <span className="hint">
                        {c.waitingUserCountsAsBusy ? "算作运行中，这一轮不暂停，5 分钟后再查" : "照常暂停，唤醒后可以继续回复"}
                      </span>
                    </div>
                  )}
                </div>

                {c.waitForT3 && (
                  <>
                    <div className="sec">等不到怎么办</div>
                    <div className="list">
                      <div className="cell col">
                        <span className="lbl">最长等待</span>
                        <div className="duration">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={20}
                            required
                            value={hours}
                            onChange={(e) => setHours(e.target.value)}
                            aria-label="小时"
                          />
                          <span>小时</span>
                          <select value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="分钟">
                            {[0, 5, 10, 15, 20, 30, 40, 45, 50].concat(Number(minutes) % 5 ? [Number(minutes)] : []).map((v) => (
                              <option key={v} value={String(v)}>
                                {v}
                              </option>
                            ))}
                          </select>
                          <span>分钟</span>
                        </div>
                        {maxWaitInvalid ? (
                          <span className="hint error-text">请填写 5 分钟到 20 小时之间的时长</span>
                        ) : (
                          <span className="hint">最晚到 {addClock(c.pauseTime, maxWait)}</span>
                        )}
                      </div>
                      <div className="cell col">
                        <span className="lbl">到时间后</span>
                        <Segmented
                          value={c.onTimeout}
                          options={[
                            ["give_up", "放弃本次暂停"],
                            ["force", "强制暂停"],
                          ]}
                          onChange={(v) => set("onTimeout", v)}
                        />
                        <span className="hint">{c.onTimeout === "force" ? "不管任务有没有结束，都暂停机器" : "让任务继续跑，这一晚不再尝试暂停"}</span>
                      </div>
                    </div>

                    <div className="list adv">
                      <button type="button" className="cell nav" onClick={() => setAdvOpen((o) => !o)} aria-expanded={advOpen}>
                        <span className="stack">
                          <span className="lbl">高级</span>
                          {!advOpen && (
                            <span className={`hint${advInvalid ? " error-text" : ""}`}>
                              {advInvalid ? "有设置需要修改" : advNonDefault.length ? advNonDefault.join(" · ") : "使用默认值"}
                            </span>
                          )}
                        </span>
                        <span className="go" aria-hidden>
                          {advOpen ? "▴" : "▾"}
                        </span>
                      </button>
                      {advOpen && (
                        <>
                          <MinutesCell
                            label="任务结束后至少再等"
                            hint="最后一个任务结束满这么久才暂停。0 表示结束就暂停"
                            field={quiet}
                          />
                          {graceApplies && (
                            <MinutesCell label="等你回复至少满" hint="任务等你满这么久才按空闲处理，留时间给你回来" field={grace} />
                          )}
                        </>
                      )}
                    </div>
                    {advOpen && <p className="note">两项都是“至少”：每 5 分钟检查一次，满足后的下一次检查才暂停，可能多等几分钟。</p>}
                  </>
                )}
              </>
            )}
          </>
        )}

        {page === "wake" && (
          <>
            <div className="list">
              <SwitchCell big label="定时唤醒" hint="到点时机器已暂停或停止，自动唤醒" checked={c.wakeEnabled} onChange={(v) => set("wakeEnabled", v)} />
              {c.wakeEnabled && (
                <label className="cell">
                  <span className="lbl">唤醒时间</span>
                  <input className="inline-input" type="time" required value={c.wakeTime} onChange={(e) => set("wakeTime", e.target.value)} />
                </label>
              )}
            </div>
            {c.wakeEnabled && (
              <>
                <div className="sec">重复</div>
                <div className="list">
                  <div className="cell col">
                    <Segmented
                      value={repeatMode}
                      options={[
                        ["daily", "每天"],
                        ["workdays", "工作日"],
                        ["custom", "自定义"],
                      ]}
                      onChange={setRepeat}
                    />
                    <div className="weekdays" role="group" aria-label="星期">
                      {["一", "二", "三", "四", "五", "六", "日"].map((label, i) => (
                        <button
                          key={label}
                          type="button"
                          aria-pressed={c.wakeDays.includes(i + 1)}
                          className={c.wakeDays.includes(i + 1) ? "on" : ""}
                          onClick={() => toggleDay(i + 1)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {wakeInvalid ? <p className="note error-text">至少选择一天</p> : <p className="note">点选星期即可自定义</p>}
              </>
            )}
          </>
        )}

        <div className="row-btns sticky">
          <button className="btn primary full" type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>

        {page === "root" && (
          <div className="danger-zone">
            {confirmRemove ? (
              <div className="row-btns">
                <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>
                  取消
                </button>
                <button type="button" className="btn danger" onClick={remove}>
                  确认停止监管
                </button>
              </div>
            ) : (
              <button type="button" className="btn ghost danger-text full" onClick={() => setConfirmRemove(true)}>
                停止监管这台机器
              </button>
            )}
          </div>
        )}
      </form>
    </Sheet>
  );
}

function MinutesCell({ label, hint, field }: { label: string; hint: string; field: ReturnType<typeof useMinutes> }) {
  return (
    <div className="cell">
      <span className="stack">
        <span className="lbl">{label}</span>
        <span className={`hint${field.valid ? "" : " error-text"}`}>{field.valid ? hint : `请填写 0 到 ${MAX_GRACE_MINUTES} 之间的整数`}</span>
      </span>
      <span className="minutes">
        <input type="number" inputMode="numeric" min={0} max={MAX_GRACE_MINUTES} value={field.text} onChange={(e) => field.setText(e.target.value)} aria-label={`${label}（分钟）`} />
        <span>分钟</span>
      </span>
    </div>
  );
}

/** 高级设置里和默认值不同的项 */
function advancedChanges(c: ScheduleConfig): string[] {
  const out: string[] = [];
  if (c.quietAfterEndMinutes !== DEFAULT_CONFIG.quietAfterEndMinutes)
    out.push(c.quietAfterEndMinutes ? `任务结束后再等 ${c.quietAfterEndMinutes} 分钟` : "任务结束就暂停");
  if (!c.waitingUserCountsAsBusy && c.waitingUserGraceMinutes !== DEFAULT_CONFIG.waitingUserGraceMinutes)
    out.push(c.waitingUserGraceMinutes ? `等你回复满 ${c.waitingUserGraceMinutes} 分钟` : "等你回复的立即按空闲");
  return out;
}

function pauseSummary(c: ScheduleConfig) {
  if (!c.enabled) return "已关闭";
  if (!c.waitForT3) return `每天 ${c.pauseTime} · 直接暂停`;
  return [
    `每天 ${c.pauseTime}`,
    `等 t3 任务结束，最长 ${formatDuration(c.maxWaitMinutes * 60_000)}`,
    `超时${c.onTimeout === "force" ? "强制暂停" : "放弃"}`,
    ...(c.waitingUserCountsAsBusy ? ["等你回复的也继续等"] : []),
    ...advancedChanges(c),
  ].join(" · ");
}

function wakeSummary(c: ScheduleConfig) {
  return c.wakeEnabled ? `${daysLabel(c.wakeDays)} ${c.wakeTime}` : "已关闭";
}

function addClock(hhmm: string, minutes: number) {
  const [h, mm] = hhmm.split(":").map(Number) as [number, number];
  const total = h * 60 + mm + minutes;
  const day = Math.floor(total / 1440);
  const t = total % 1440;
  const s = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  return day === 0 ? `当天 ${s}` : `次日 ${s}`;
}

function AddMachine({ onAdded, onError }: { onAdded: (m: MachineOverview) => void; onError: (msg: string) => void }) {
  const [list, setList] = useState<InstaboxMachineSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .instaboxMachines()
      .then((r) => setList(r.machines))
      .catch((e) => setErr((e as Error).message));
  }, []);

  const add = async (id: string) => {
    setAdding(id);
    try {
      onAdded(await apiClient.addMachine(id));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  if (err) return <p className="error-text">{err}</p>;
  if (!list) return <p className="muted">正在读取 instabox 上的机器…</p>;
  if (!list.length) return <p className="muted">instabox 账户下没有机器。</p>;
  return (
    <ul className="pick-list">
      {list.map((m) => (
        <li key={m.id}>
          <button className="pick" disabled={m.monitored || !!adding} onClick={() => add(m.id)}>
            <StateDot state={m.state} />
            <span className="pick-name">
              {m.name}
              <span className="muted small mono"> {m.id}</span>
            </span>
            <span className="muted small">{m.monitored ? "已监管" : adding === m.id ? "添加中…" : STATE_LABEL[m.state]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
