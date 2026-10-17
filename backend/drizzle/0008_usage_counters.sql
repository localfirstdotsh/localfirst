CREATE TABLE "project_usage_daily" (
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"day_utc" text NOT NULL,
	"channel" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "project_usage_daily_pk" UNIQUE("project_id","version_id","day_utc","channel"),
	CONSTRAINT "project_usage_daily_channel_check" CHECK ("project_usage_daily"."channel" in ('rest_export', 'mcp_retrieval'))
);
--> statement-breakpoint
CREATE TABLE "site_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_usage_daily" ADD CONSTRAINT "project_usage_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_usage_daily" ADD CONSTRAINT "project_usage_daily_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_usage_daily_project_idx" ON "project_usage_daily" USING btree ("project_id");

--> statement-breakpoint
CREATE FUNCTION "count_oauth_consent_granted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "site_counters" ("key", "value") VALUES ('connections_authorized', 1)
  ON CONFLICT ("key") DO UPDATE SET "value" = "site_counters"."value" + 1;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "oauth_consent_granted_count" AFTER INSERT ON "oauth_consent"
  FOR EACH ROW EXECUTE FUNCTION "count_oauth_consent_granted"();
--> statement-breakpoint
INSERT INTO "site_counters" ("key", "value")
  SELECT 'connections_authorized', count(*) FROM "oauth_consent"
  ON CONFLICT ("key") DO NOTHING;
