CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_number` integer NOT NULL CHECK (`attempt_number` > 0),
	`state` text NOT NULL CHECK (`state` IN ('running', 'recovering', 'completed', 'failed')),
	`worker_id` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`heartbeat_at` text NOT NULL,
	`recovery_count` integer DEFAULT 0 NOT NULL CHECK (`recovery_count` >= 0),
	`recovery_metadata` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `executions_task_attempt_unique` ON `executions` (`task_id`,`attempt_number`);
--> statement-breakpoint
CREATE INDEX `executions_state_heartbeat_idx` ON `executions` (`state`,`heartbeat_at`);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`execution_id` text,
	`previous_status` text,
	`new_status` text NOT NULL,
	`reason` text NOT NULL,
	`correlation_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_events_task_created_idx` ON `task_events` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `worker_lease` (
	`key` text PRIMARY KEY NOT NULL,
	`worker_id` text,
	`execution_id` text,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`last_poll_at` text,
	`shutting_down` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `worker_lease` (`key`, `updated_at`) VALUES ('global', CURRENT_TIMESTAMP);
--> statement-breakpoint
INSERT INTO `task_events` (`id`, `task_id`, `previous_status`, `new_status`, `reason`, `correlation_id`, `created_at`)
SELECT lower(hex(randomblob(16))), `id`, NULL, `status`, 'Imported from Phase 1', lower(hex(randomblob(16))), `created_at` FROM `tasks`;
