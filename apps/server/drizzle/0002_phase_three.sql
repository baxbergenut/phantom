ALTER TABLE `executions` ADD `codex_thread_id` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `retry_count` integer DEFAULT 0 NOT NULL CHECK (`retry_count` >= 0);
--> statement-breakpoint
ALTER TABLE `executions` ADD `final_result` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `token_usage` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `raw_log_path` text;
--> statement-breakpoint
CREATE TABLE `execution_events` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('thread', 'progress', 'command', 'file_change', 'usage', 'failure', 'final')),
	`message` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_events_execution_sequence_unique` ON `execution_events` (`execution_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `execution_events_execution_created_idx` ON `execution_events` (`execution_id`,`created_at`);
