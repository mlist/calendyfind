CREATE TABLE `freebusy_feed` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`secret_token` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_rotated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `freebusy_feed_secret_token_unique` ON `freebusy_feed` (`secret_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `freebusy_feed_user_unique` ON `freebusy_feed` (`user_id`);