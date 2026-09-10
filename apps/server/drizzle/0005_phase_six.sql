ALTER TABLE `tasks` ADD `classification` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `classifier_version` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `classification_source` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `classifier_fallback_used` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `model_tier` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `selected_model` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `selected_reasoning` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `model_fallback_used` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `model_selection_rationale` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `quota_estimate_percent` real;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `quota_estimate_source` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `quota_estimate_sample_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `executions` ADD `complexity` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `model_tier` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `selected_model` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `selected_reasoning` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `model_fallback_used` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `executions` ADD `classifier_version` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `classifier_fallback_used` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `executions` ADD `classification` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `model_selection_rationale` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `quota_estimate_percent` real;
--> statement-breakpoint
ALTER TABLE `executions` ADD `quota_estimate_source` text;
--> statement-breakpoint
ALTER TABLE `executions` ADD `quota_estimate_sample_count` integer DEFAULT 0 NOT NULL;
