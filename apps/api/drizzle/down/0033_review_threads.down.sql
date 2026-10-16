-- Reverts 0033_review_threads.sql (ADR 0017 slice S2).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0033 from drizzle.__drizzle_migrations. It DELETES every review
-- comment thread and comment; reviews, decisions, revisions and agents are untouched. An application
-- version before this slice ignores the tables.
DROP TABLE IF EXISTS "agent_review_comments";
DROP TABLE IF EXISTS "agent_review_threads";
