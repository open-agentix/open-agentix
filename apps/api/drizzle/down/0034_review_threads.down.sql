-- Reverts 0034_review_threads.sql (ADR 0017 slice S2).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0033 from drizzle.__drizzle_migrations. It DELETES every review
-- comment thread and comment; reviews, decisions, revisions and agents are untouched. An application
-- version before this slice ignores the tables.
DROP TRIGGER IF EXISTS agent_review_comments_no_truncate ON agent_review_comments;
DROP TRIGGER IF EXISTS agent_review_threads_no_truncate ON agent_review_threads;
DROP TRIGGER IF EXISTS agent_review_comments_no_delete ON agent_review_comments;
DROP TRIGGER IF EXISTS agent_review_threads_no_delete ON agent_review_threads;
DROP TABLE IF EXISTS "agent_review_comments";
DROP TABLE IF EXISTS "agent_review_threads";
ALTER TABLE "agent_reviews" DROP CONSTRAINT IF EXISTS "agent_reviews_id_agent_tenant_uq";
