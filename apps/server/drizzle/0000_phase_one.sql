CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`local_path` text NOT NULL,
	`remote_name` text DEFAULT 'origin' NOT NULL,
	`remote_branch` text DEFAULT 'main' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`validation_commands` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_local_path_unique` ON `projects` (`local_path`);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL CHECK (`priority` IN ('urgent', 'high', 'normal', 'low')),
	`status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued', 'classifying', 'waiting_quota', 'running', 'retrying', 'completed', 'failed', 'blocked')),
	`attempt_count` integer DEFAULT 0 NOT NULL CHECK (`attempt_count` >= 0),
	`status_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_queue_order_idx` ON `tasks` (`status`, `priority`, `created_at`);
--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `updated_at`) VALUES ('worker.paused', 'false', CURRENT_TIMESTAMP);

