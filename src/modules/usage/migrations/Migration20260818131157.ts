import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260818131157 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "usage_billing_period" ("id" text not null, "starts_at" timestamptz not null, "ends_at" timestamptz not null, "subject" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "usage_billing_period_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_billing_period_deleted_at" ON "usage_billing_period" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_billing_period_subject_starts_at" ON "usage_billing_period" ("subject", "starts_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_billing_period_ends_at" ON "usage_billing_period" ("ends_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "usage_period_result" ("id" text not null, "starts_at" timestamptz not null, "digest" text not null, "closed_at" timestamptz not null, "currency" text not null, "ends_at" timestamptz not null, "result" jsonb not null, "subject" text not null, "total_amount" numeric not null, "raw_total_amount" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "usage_period_result_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_period_result_deleted_at" ON "usage_period_result" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_period_result_subject_starts_at" ON "usage_period_result" ("subject", "starts_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_usage_period_result_closed_at" ON "usage_period_result" ("closed_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "usage_billing_period" cascade;`);

    this.addSql(`drop table if exists "usage_period_result" cascade;`);
  }

}
