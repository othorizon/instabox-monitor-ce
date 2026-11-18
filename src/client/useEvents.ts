import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "./api";
import type { ActivityEvent } from "../shared/types";

/** 和服务端一致：ts 倒序，同一时刻按 id 倒序 */
const byNewest = (a: ActivityEvent, b: ActivityEvent) => b.ts - a.ts || b.id - a.id;

function merge(list: ActivityEvent[], incoming: ActivityEvent[]) {
  const seen = new Set(list.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  return fresh.length ? [...list, ...fresh].sort(byNewest) : list;
}

/**
 * 某台机器的活动列表：
 * - 切换机器时清空并拉第一页
 * - refresh() 只拉比当前最新一条更新的记录（轮询用）
 * - loadMore() 按游标拉更早的一页
 */
export function useEvents(machineId: string | undefined) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  // 切换机器后，丢弃旧机器还没回来的请求
  const gen = useRef(0);
  const loadingMoreRef = useRef(false);

  const loadFirst = useCallback(async () => {
    const g = gen.current;
    const r = await apiClient.events(machineId);
    if (g !== gen.current) return;
    setEvents(r.events);
    setHasMore(r.hasMore);
  }, [machineId]);

  useEffect(() => {
    gen.current++;
    loadingMoreRef.current = false;
    setEvents(null);
    setHasMore(false);
    setLoadingMore(false);
    // 失败时保持“加载中”，下次轮询的 refresh() 会重试
    if (machineId) loadFirst().catch(() => {});
  }, [machineId, loadFirst]);

  const refresh = useCallback(async () => {
    if (!machineId) return;
    const list = eventsRef.current;
    try {
      if (!list) return void (await loadFirst());
      const g = gen.current;
      const after = list.reduce((max, e) => Math.max(max, e.id), 0);
      const r = await apiClient.events(machineId, { after });
      if (g !== gen.current) return;
      // 新增太多、中间可能有缺口：直接重载第一页
      if (r.hasMore) return void (await loadFirst());
      if (r.events.length) setEvents((cur) => (cur ? merge(cur, r.events) : cur));
    } catch {
      // 活动加载失败不影响主操作
    }
  }, [machineId, loadFirst]);

  const loadMore = useCallback(async () => {
    const list = eventsRef.current;
    if (!machineId || !list?.length || loadingMoreRef.current) return;
    const last = list[list.length - 1]!;
    const g = gen.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const r = await apiClient.events(machineId, { before: { ts: last.ts, id: last.id } });
      if (g !== gen.current) return;
      setEvents((cur) => (cur ? merge(cur, r.events) : cur));
      setHasMore(r.hasMore);
    } catch {
      // 留着按钮让用户重试
    } finally {
      if (g === gen.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [machineId]);

  return { events, hasMore, loadingMore, refresh, loadMore };
}
