ALTER TABLE `login_codes` ADD `auth_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `logins` ADD `auth_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `auth_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_at` ON `audit` (`at`);--> statement-breakpoint
CREATE INDEX `backup_created` ON `backups` (`created`);--> statement-breakpoint
CREATE INDEX `correction_person_interval` ON `corrections` (`person_id`,`start`,`end`);