ALTER TABLE `tasks` ADD `complexity` text DEFAULT 'medium' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `quota_wait_until` text;
--> statement-breakpoint
CREATE TABLE `quota_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`source` text NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quota_snapshots_observed_idx` ON `quota_snapshots` (`observed_at`);
--> statement-breakpoint
CREATE TABLE `quota_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`limit_id` text NOT NULL,
	`limit_name` text,
	`kind` text NOT NULL,
	`used_percent` real NOT NULL,
	`remaining_percent` real NOT NULL,
	`window_duration_mins` integer,
	`resets_at` text,
	`plan_type` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `quota_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quota_windows_snapshot_idx` ON `quota_windows` (`snapshot_id`);
--> statement-breakpoint
ALTER TABLE `executions` ADD `quota_before_snapshot_id` text REFERENCES quota_snapshots(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `executions` ADD `quota_after_snapshot_id` text REFERENCES quota_snapshots(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `executions` ADD `quota_usage_delta` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `quota_wait_until` text;
