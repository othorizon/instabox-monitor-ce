-- 定时暂停的高级设置：
-- 最后一个 t3 任务结束后至少再等多久才暂停；等你回复的任务至少等你多久才按空闲处理（分钟，0 = 不等）
ALTER TABLE pause_config ADD COLUMN quiet_after_end_minutes INTEGER NOT NULL DEFAULT 10;
ALTER TABLE pause_config ADD COLUMN waiting_user_grace_minutes INTEGER NOT NULL DEFAULT 30;
