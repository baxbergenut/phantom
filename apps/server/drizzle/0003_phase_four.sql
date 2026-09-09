ALTER TABLE `executions` ADD `starting_head` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `starting_remote_sha` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `ending_head` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `ending_remote_sha` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `changed_files` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `commit_metadata` text;
