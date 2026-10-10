# Grafana dashboard

`openagentix-overview.json` shows the platform-wide Prometheus metrics of the api and worker
(`/metrics`, see [`docs/observability.md`](../../docs/observability.md)): runs, durations, tool
calls, approvals, tokens, cost, budget stops, context guard hits, events, run node reports and the
health of the tracing pipeline.

Import it in Grafana (Dashboards, Import) and pick your Prometheus data source for
`DS_PROMETHEUS`. Every label is a closed value set; there is no tenant, agent or connection
label, so the dashboard is safe on a Prometheus that several teams read. Per-tenant numbers come
from the cost and run APIs.
