-- 定时唤醒配置（和定时暂停共用一行配置与时区）
ALTER TABLE pause_config ADD COLUMN wake_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pause_config ADD COLUMN wake_time TEXT NOT NULL DEFAULT '08:30';
-- ISO 星期，1 = 周一 … 7 = 周日，逗号分隔
ALTER TABLE pause_config ADD COLUMN wake_days TEXT NOT NULL DEFAULT '1,2,3,4,5';

-- 每台机器每天最多触发一次定时唤醒
CREATE TABLE wake_runs (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  wake_date TEXT NOT NULL,
  result TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (machine_id, wake_date)
);
