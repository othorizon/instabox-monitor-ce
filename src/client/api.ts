import type { ActivityEvent, InstaboxMachineSummary, MachineOverview, ScheduleConfig, ProbeResult } from "../shared/types";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Access 登录页等非 JSON 响应
  }
  if (!res.ok || data === null) {
    if (res.status === 401 || res.status === 403 || data === null) {
      throw new Error(data?.error ?? "登录已失效，请刷新页面重新登录");
    }
    throw new Error(data?.error ?? `请求失败（${res.status}）`);
  }
  return data as T;
}

export const apiClient = {
  overview: () => req<{ machines: MachineOverview[]; now: number }>("GET", "/api/overview"),
  machine: (id: string) => req<MachineOverview>("GET", `/api/machines/${id}`),
  pause: (id: string) => req<MachineOverview>("POST", `/api/machines/${id}/pause`),
  wake: (id: string) => req<MachineOverview>("POST", `/api/machines/${id}/wake`),
  probe: (id: string) => req<{ probe: ProbeResult; probeAt: number }>("POST", `/api/machines/${id}/probe`),
  saveConfig: (id: string, c: ScheduleConfig) => req<MachineOverview>("PUT", `/api/machines/${id}/config`, c),
  events: (machineId: string | undefined, cursor: { before?: { ts: number; id: number }; after?: number } = {}) => {
    const p = new URLSearchParams();
    if (machineId) p.set("machine", machineId);
    if (cursor.before) p.set("before", `${cursor.before.ts}:${cursor.before.id}`);
    if (cursor.after !== undefined) p.set("after", String(cursor.after));
    return req<{ events: ActivityEvent[]; hasMore: boolean }>("GET", `/api/events?${p}`);
  },
  instaboxMachines: () => req<{ machines: InstaboxMachineSummary[] }>("GET", "/api/instabox/machines"),
  addMachine: (id: string) => req<MachineOverview>("POST", "/api/machines", { id }),
  skipPause: (id: string, cycleDate: string) => req<MachineOverview>("POST", `/api/machines/${id}/skip-pause`, { cycleDate }),
  unskipPause: (id: string, cycleDate: string) => req<MachineOverview>("DELETE", `/api/machines/${id}/skip-pause`, { cycleDate }),
  removeMachine: (id: string) => req<{ ok: true }>("DELETE", `/api/machines/${id}`),
};
