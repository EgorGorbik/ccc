CREATE TABLE `session_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`project_id` text NOT NULL,
	`device_id` text NOT NULL,
	`start` integer NOT NULL,
	`last` integer NOT NULL,
	`end` integer NOT NULL,
	`reason` text NOT NULL,
	`event_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archive_person_start` ON `session_archive` (`person_id`,`start`);