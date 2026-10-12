CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`created` integer NOT NULL,
	`checksum` text NOT NULL,
	`bytes` integer NOT NULL,
	`verified` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`platform_id` text NOT NULL,
	`hash` text NOT NULL,
	`expires` integer NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `otp_person` ON `login_codes` (`person_id`,`created`);--> statement-breakpoint
CREATE TABLE `review_events` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`device_id` text NOT NULL,
	`project_id` text NOT NULL,
	`at` integer NOT NULL,
	`seq` integer,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created` integer NOT NULL,
	`resolved` integer,
	`actor` text,
	`resolution` text
);
--> statement-breakpoint
CREATE INDEX `review_person_status` ON `review_events` (`person_id`,`status`,`created`);--> statement-breakpoint
ALTER TABLE `devices` ADD `pending_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `review_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `status` text DEFAULT 'waiting' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `extension_version` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `clock_offset` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `event_device_sequence` ON `events` (`device_id`,`seq`);