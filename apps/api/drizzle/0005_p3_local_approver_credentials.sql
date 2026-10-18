CREATE TABLE "approver_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approver_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"poll_hash" text NOT NULL,
	"client_label" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approver_links_state_check" CHECK ("approver_links"."state" in ('pending', 'approved', 'denied', 'redeemed'))
);
--> statement-breakpoint
ALTER TABLE "publication_approvals" ADD COLUMN "approver_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "approver_credentials" ADD CONSTRAINT "approver_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_links" ADD CONSTRAINT "approver_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approver_credentials_secret_uidx" ON "approver_credentials" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "approver_credentials_user_idx" ON "approver_credentials" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approver_links_open_code_uidx" ON "approver_links" USING btree ("user_code") WHERE "approver_links"."state" in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "approver_links_expiry_idx" ON "approver_links" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "publication_approvals" ADD CONSTRAINT "publication_approvals_approver_credential_id_approver_credentials_id_fk" FOREIGN KEY ("approver_credential_id") REFERENCES "public"."approver_credentials"("id") ON DELETE set null ON UPDATE no action;