// 通过 instabox exec 在机器上只读查询 t3 的状态库，判断有没有进行中的任务、任务什么时候结束。
//
// t3 的数据在 ~/.t3/userdata/statev2.sqlite（或 $T3CODE_HOME/userdata）：
// - orchestration_v2_projection_runs.status 为 queued/preparing/starting/running/waiting：线程有一个进行中的 run
// - orchestration_v2_projection_runtime_requests 中同线程 status = 'pending' 的记录：
//   run 停下来等你（kind 含 approval 是等你批准，其余如 user_input 是等你回答），created_at 是开始等你的时间
// - runs.completed_at 的最大值：最近一次任务结束的时间
// 这是 t3 的内部表结构（t3 0.1.9 验证），升级后可能变化；查询失败时返回 ok:false。

import type { Instabox } from "./instabox";
import type { ProbeResult, ProbeThread } from "../shared/types";
import { pauseBlocker } from "../shared/pauseGate";

export const PROBE_SCRIPT = String.raw`
import json, os, sqlite3, sys
home = os.environ.get("T3CODE_HOME") or os.path.expanduser("~/.t3")
db = os.path.join(home, "userdata", "statev2.sqlite")
if not os.path.exists(db):
    print(json.dumps({"ok": False, "error": "t3 state db not found: " + db}))
    sys.exit(0)
try:
    c = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=10)
    has_req = c.execute(
        "select 1 from sqlite_master where name='orchestration_v2_projection_runtime_requests'"
    ).fetchone() is not None
    def pending(col):
        if not has_req:
            return "null"
        return ("(select " + col + " from orchestration_v2_projection_runtime_requests q"
                " where q.thread_id = r.thread_id and q.status = 'pending' order by q.created_at desc limit 1)")
    live = "r.status in ('queued', 'preparing', 'starting', 'running', 'waiting')"
    rows = c.execute(
        "select r.thread_id, coalesce(t.title, ''), r.requested_at, " + pending("q.kind") + ", " + pending("q.created_at") +
        " from orchestration_v2_projection_runs r"
        " left join orchestration_v2_projection_threads t on t.thread_id = r.thread_id"
        " where " + live + " and (t.deleted_at is null)"
        " order by r.requested_at"
    ).fetchall()
    threads = [
        {"threadId": tid, "title": title, "since": since, "pendingKind": kind, "waitingSince": wsince,
         "state": "waiting_user" if kind else "running"}
        for (tid, title, since, kind, wsince) in rows
    ]
    last_ended = c.execute(
        "select max(r.completed_at) from orchestration_v2_projection_runs r"
        " left join orchestration_v2_projection_threads t on t.thread_id = r.thread_id"
        " where r.completed_at is not null and (t.deleted_at is null)"
    ).fetchone()[0]
    print(json.dumps({"ok": True, "threads": threads, "lastEndedAt": last_ended}))
except Exception as e:
    print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)}))
`;

export function parseProbeOutput(stdout: string, exitCode: number, stderr = ""): ProbeResult {
  const line = stdout.trim().split("\n").pop() ?? "";
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return failed(`探测输出无法解析（exit ${exitCode}）：${(stderr || stdout).slice(0, 200)}`);
  }
  if (!data?.ok) return failed(String(data?.error ?? "unknown error"));
  const threads: ProbeThread[] = Array.isArray(data.threads) ? data.threads : [];
  return {
    ok: true,
    running: threads.filter((t) => t.state === "running").length,
    waitingUser: threads.filter((t) => t.state === "waiting_user").length,
    threads,
    lastEndedAt: typeof data.lastEndedAt === "string" ? data.lastEndedAt : null,
  };
}

function failed(error: string): ProbeResult {
  return { ok: false, error, running: 0, waitingUser: 0, threads: [] };
}

export async function probeT3(api: Instabox, machineId: string): Promise<ProbeResult> {
  try {
    const res = await api.exec(machineId, {
      argv: ["python3", "-I", "-"],
      stdin: PROBE_SCRIPT,
      timeoutSeconds: 30,
      noHistory: true,
    });
    return parseProbeOutput(res.stdout, res.exitCode, res.stderr);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 这一轮检查是否要继续等待（不暂停）。详见 shared/pauseGate。
 */
export function isBusy(probe: ProbeResult, config: Parameters<typeof pauseBlocker>[1], now: number): boolean {
  return pauseBlocker(probe, config, now) !== null;
}
