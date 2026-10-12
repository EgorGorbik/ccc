CREATE TABLE `pay_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`usd_cents` integer NOT NULL,
	`effective_from` integer NOT NULL,
	`actor` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pay_rate_person_from` ON `pay_rates` (`person_id`,`effective_from`);
--> statement-breakpoint
CREATE TABLE `project_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`usd_cents` integer NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`actor` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_budget_project` ON `project_budgets` (`project_id`);
