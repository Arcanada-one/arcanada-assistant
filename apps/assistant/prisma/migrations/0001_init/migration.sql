-- ARCA-0006 init migration — smoke User table.
-- Full schema (Conversation, Message, Profile, audit triggers) lands in ARCA-0008.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE "users" (
    "id"           UUID         NOT NULL DEFAULT uuid_generate_v4(),
    "telegram_id"  BIGINT       NOT NULL,
    "username"     VARCHAR(64),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");
CREATE INDEX "users_telegram_id_idx"  ON "users"("telegram_id");
