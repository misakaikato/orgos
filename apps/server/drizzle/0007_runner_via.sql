-- 设备来源：桌面客户端内置的 Runner（desktop）或命令行 Runner（cli）；较早配对的设备为空。可重复执行。
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "via" text;
