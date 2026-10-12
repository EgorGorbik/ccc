CREATE TABLE `office_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL DEFAULT 'requested',
	`error` text NOT NULL DEFAULT '',
	`member_seen` integer NOT NULL DEFAULT 0,
	`owner_seen` integer NOT NULL DEFAULT 0,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `office_session_person` ON `office_sessions` (`person_id`,`status`,`created`);
--> statement-breakpoint
CREATE TABLE `office_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`sender` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `office_signal_session` ON `office_signals` (`session_id`,`created`);
