import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260818075331 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "usage_event" ("id" text not null, "occurred_at" timestamptz not null, "meter" text not null, "properties" jsonb null, "quantity" numeric not null, "source" text null, "subject" text not null, "raw_quantity" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "usage_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_event_deleted_at" ON "usage_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_event_meter_subject_occurred_at" ON "usage_event" ("meter", "subject", "occurred_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_event_meter_occurred_at" ON "usage_event" ("meter", "occurred_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "usage_event" cascade;`);
  }

}
