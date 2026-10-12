CREATE TABLE `attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`detail` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `corrections` (
	`session_id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`project_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`last_seen` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_person` ON `devices` (`person_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`device_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`received` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_person_order` ON `events` (`person_id`,`at`,`received`,`id`);--> statement-breakpoint
CREATE TABLE `logins` (
	`hash` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`platform_id` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_person` ON `logins` (`person_id`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`job` text DEFAULT '' NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`equipment` text DEFAULT '' NOT NULL,
	`code_hash` text,
	`active` integer DEFAULT 1 NOT NULL,
	`onboarded` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
