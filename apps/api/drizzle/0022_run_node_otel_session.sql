-- ADR 0015 / slice S4 (#209): bounded telemetry state of a run node session. Additive: one nullable
-- column and one shape check; no backfill (sessions created before this migration, or while tracing
-- is off, keep NULL and produce no `oax.node.session` span). Down path:
-- drizzle/down/0022_run_node_otel_session.down.sql
-- * run_node_sessions.otel_session: {runner, harness, dropped, events[]}. Written by the control node
--   only (never from a node's own text): created with the session, appended to after an accepted
--   node report (at most OAX_OTEL_NODE_EVENTS_MAX events, the config accepts at most 1000), read once when the
--   session is revoked, when the span is emitted.
-- * run_node_sessions_otel_session_shape: an object with an events array of at most 1000 entries
--   and a numeric dropped counter, whatever code path writes the row (a missing key is a failure,
--   not an unknown, hence the coalesce).
ALTER TABLE "run_node_sessions" ADD COLUMN "otel_session" jsonb;--> statement-breakpoint
ALTER TABLE "run_node_sessions" ADD CONSTRAINT "run_node_sessions_otel_session_shape" CHECK ("run_node_sessions"."otel_session" is null or (coalesce(jsonb_typeof("run_node_sessions"."otel_session") = 'object' and jsonb_typeof("run_node_sessions"."otel_session"->'events') = 'array' and jsonb_array_length(case when jsonb_typeof("run_node_sessions"."otel_session"->'events') = 'array' then "run_node_sessions"."otel_session"->'events' else '[]'::jsonb end) <= 1000 and jsonb_typeof("run_node_sessions"."otel_session"->'dropped') = 'number', false)));
