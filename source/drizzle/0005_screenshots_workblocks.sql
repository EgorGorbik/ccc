CREATE TABLE `screenshots` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `screenshot_person_time` ON `screenshots` (`person_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `work_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`project_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`actor` text NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_block_person_interval` ON `work_blocks` (`person_id`,`start`,`end`);
