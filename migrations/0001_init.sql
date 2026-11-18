-- 被监管的机器
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  -- 最近一次 Cron 观察到的状态，用于发现外部状态变化
  last_state TEXT,
  last_state_at INTEGER,
  -- 本服务最近一次主动操作，用于区分“自己触发的状态变化”和“外部变化”
  last_action_at INTEGER,
  last_action_target TEXT,
  -- 最近一次 t3 检测结果（JSON）
  probe_json TEXT,
  probe_at INTEGER,
  last_error TEXT
);

-- 每台机器一份定时暂停配置
CREATE TABLE pause_config (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  pause_time TEXT NOT NULL DEFAULT '22:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  wait_for_t3 INTEGER NOT NULL DEFAULT 1,
  -- 等你回复的任务是否也算运行中（算的话这一轮检查不暂停）
  waiting_user_counts_as_busy INTEGER NOT NULL DEFAULT 0,
  max_wait_minutes INTEGER NOT NULL DEFAULT 480,
  on_timeout TEXT NOT NULL DEFAULT 'give_up' CHECK (on_timeout IN ('force', 'give_up')),
  updated_at INTEGER
);

-- 每晚一条执行记录：cycle_date 是该次暂停时间点所在的本地日期
CREATE TABLE nightly_runs (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  cycle_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'done')),
  result TEXT,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  last_check_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (machine_id, cycle_date)
);

-- 活动记录，保留 30 天
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX events_ts ON events (ts);
CREATE INDEX events_machine_ts ON events (machine_id, ts);
