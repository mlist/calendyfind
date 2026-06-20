CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`role` text DEFAULT 'user',
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`working_hours` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`ip` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`);--> statement-breakpoint
CREATE TABLE `availability_source` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`ics_url` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_fetched_at` integer,
	`cached_busy` text,
	`fetch_error` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `booking` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_page_id` text,
	`organizer_user_id` text NOT NULL,
	`attendee_name` text NOT NULL,
	`attendee_email` text NOT NULL,
	`title` text,
	`start_utc` integer NOT NULL,
	`end_utc` integer NOT NULL,
	`status` text NOT NULL,
	`ics_uid` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`external_event_ref` text,
	`expires_at` integer,
	`cancel_token` text NOT NULL,
	`email_failed` integer DEFAULT false NOT NULL,
	`write_target_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`booking_page_id`) REFERENCES `booking_page`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organizer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`write_target_id`) REFERENCES `write_target`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_ics_uid_unique` ON `booking` (`ics_uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `booking_cancel_token_unique` ON `booking` (`cancel_token`);--> statement-breakpoint
CREATE INDEX `booking_organizer_start_idx` ON `booking` (`organizer_user_id`,`start_utc`);--> statement-breakpoint
CREATE INDEX `booking_status_idx` ON `booking` (`status`);--> statement-breakpoint
CREATE INDEX `booking_page_idx` ON `booking` (`booking_page_id`);--> statement-breakpoint
CREATE TABLE `booking_attendee` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`user_id` text NOT NULL,
	`invite_status` text DEFAULT 'needs_action' NOT NULL,
	`email_failed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `booking`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_attendee_unique_idx` ON `booking_attendee` (`booking_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `booking_page` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`secret_token` text NOT NULL,
	`title` text NOT NULL,
	`duration_options` text DEFAULT '[30]' NOT NULL,
	`buffer_min` integer DEFAULT 0 NOT NULL,
	`min_notice_min` integer DEFAULT 60 NOT NULL,
	`max_advance_days` integer DEFAULT 30 NOT NULL,
	`location` text,
	`write_target_id` text,
	`active` integer DEFAULT true NOT NULL,
	`token_rotated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`write_target_id`) REFERENCES `write_target`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_page_secret_token_unique` ON `booking_page` (`secret_token`);--> statement-breakpoint
CREATE TABLE `reminder` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`offset_min` integer NOT NULL,
	`scheduled_for` integer NOT NULL,
	`sent_at` integer,
	`failed_at` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `booking`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_booking_offset_unique` ON `reminder` (`booking_id`,`offset_min`);--> statement-breakpoint
CREATE INDEX `reminder_scheduled_idx` ON `reminder` (`scheduled_for`);--> statement-breakpoint
CREATE TABLE `write_target` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`calendar_ref` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
