# Demo profile

The public demo (demo.openagentix.si) is the normal platform with `OAX_DEMO_MODE=true`: fake data on
`example.org`, a read-only API (except sign-in and side-effect-free checks), the simulated provider
and the built-in demo MCP servers. Visitors can start **fixed scenarios**; nothing they type ever
reaches a model.

## Run it locally (simulated, no network, no cost)

```bash
docker compose -f docker-compose.demo.yml up --build
```

UI <http://localhost:3000>, API <http://localhost:8080>, sign in as `admin@example.org` with
`demo-password-2026` (a shared fake password, see `docs/configuration.md`). The stack is api,
worker, ui and PostgreSQL; the API seeds the data set on first start and the worker executes the
scenario runs with the simulated provider. On the dashboard, "Try a scenario" starts one of three
CVE-triage scenarios and opens the run.

Without the compose file (single process, in-memory database): `pnpm seed:demo` and the API with
`OAX_DEMO_MODE=true`.

## Guided tour

Visitors get a guided tour in demo mode only (`GET /v1/settings` reports `demo: true`; outside demo
mode neither the tour nor its menu entry exist).

- **What it is**: a modal dialog with 8 short steps (who you are, "Try a scenario", the run view,
  the audit hash chain, costs, agents/tenants/roles, connections and policies, links). Each step
  spotlights the matching part of the UI through its `data-tour` anchor and shows the page it is
  about. Without the anchor (hidden, missing) or on screens up to 900 px wide (bottom sheet) the
  card is shown without a spotlight.
- **Keyboard**: Esc closes, Left/Right arrows go back and forward, Tab stays inside the dialog,
  focus returns to where the tour was opened. Reduced motion is respected.
- **Start**: it starts once per browser session after the first landing on the dashboard, unless
  "Don't show this again" was ticked. "Take the tour" in the sidebar starts it any time and ignores
  the dismissal. On the sign-in page (image built with `VITE_OAX_DEMO=true`, set in
  `docker-compose.demo.yml`; the page has no API data before sign-in) a hint box shows the shared
  fake credentials, the nightly reset and a "Take the tour" link that starts it after sign-in.
- **Persistence**: the dismissal is `localStorage` key `oax.tour.dismissed` (`1`). If storage is
  blocked it falls back to `sessionStorage` and then to memory (no cookies, nothing is sent to the
  server). The "started in this session" flag is `oax.tour.autostarted` in `sessionStorage`.
- **Reset the dismissal**: untick the checkbox in any step, use "Take the tour", or run
  `localStorage.removeItem('oax.tour.dismissed')` in the browser console.
- **Docker build argument**: the UI image reads `VITE_OAX_DEMO` at build time (`ARG VITE_OAX_DEMO` in
  `apps/ui/Dockerfile`, baked into the bundle by Vite). Build the public demo image with
  `docker build -f apps/ui/Dockerfile --build-arg VITE_OAX_DEMO=true -t open-agentix-ui:demo .`
  (`docker-compose.demo.yml` already passes it). Without it the sign-in hint is not shown; the tour
  itself needs no flag.
- **Code**: `apps/ui/src/features/tour/` (steps and anchors in `steps.ts`, texts under `tour` in the
  locale files, the dialog is a lazy chunk so the initial bundle is unchanged). The links of the
  last step are plain `<a>` elements; the offline check allows `github.com` and `openagentix.si`
  for them only.

## Scenarios

`GET /v1/demo/scenarios` lists them with the limits; `POST /v1/demo/scenarios/{id}/run` (no body)
queues a run of the seeded `cve-triage` agent. The event data comes from a fixed table
(`apps/api/src/demo/scenarios.ts`), the worker re-derives it from that table again, and the endpoint
accepts no free text. Both endpoints answer 404 outside demo mode.

Limits (all configurable, see `docs/configuration.md`): runs per visitor and window (default 3 per
10 minutes; the visitor is a salted hash of the client IP, so set `OAX_TRUST_PROXY=true` behind an
ingress), runs per day for the whole demo (100), and `429` with `Retry-After` when exceeded.

> **Planned:** a real read-only agent that answers visitor questions from the public repository
> (design: [demo-repo-agent.md](demo-repo-agent.md), plan item W11-1). Not implemented yet; until it
> ships, nothing a visitor types reaches a model.
>
> **Concept:** a separate showcase installation where six real agents work on the project's own
> repositories, each in its own tenant, with a read-only guest view of runs, costs and audit
> ([showcase-agents.md](showcase-agents.md)).

## Optional: live Claude Code runs (`OAX_DEMO_LLM=claude-code`)

Scenario runs are executed by the Claude Code harness (`docs/harnesses.md`) instead of the simulated
provider. Safeguards, all enforced in code and tested:

- **Fixed scenarios only**: the stored event is ignored, the model sees only the table data; other
  runs (for example webhooks) keep using the simulated provider.
- **No built-in tools, no outbound tools**: the CLI runs with `--tools ""`; its only tool source is the
  policy gate with the in-memory demo servers `cve-db` and `tickets`. A definition that grants any
  other server is refused (`demo_tool_refused`).
- **Strict limits** per run: model forced to `OAX_DEMO_LLM_MODEL` (default `haiku`), at most 4 turns per
  agent, 120 s, `$0.05` (`OAX_DEMO_LLM_RUN_BUDGET_USD`).
- **Daily budget cap** (`OAX_DEMO_LLM_DAILY_BUDGET_USD`, default `$1`): summed from the recorded run
  costs plus a reservation for runs in flight; one live run at a time (`demo_busy`); then
  `demo_budget_exhausted` until the next UTC day.
- **Per-visitor rate limit** and a daily run cap as above.

### Supplying the token (owner only)

The repository contains no token and nothing here creates one. The owner runs `claude setup-token`
once on a machine where they are signed in, stores the printed token in a file (mode 0600) and
mounts that file **read-only into the worker only**:

```bash
mkdir -p secrets && (umask 077; cat > secrets/claude-oauth-token)   # paste the token, then Ctrl-D
docker compose -f docker-compose.demo.yml -f docker-compose.demo-claude.yml up --build
```

`secrets/` is git- and docker-ignored. The overlay uses the Dockerfile target `worker-claude` (worker
plus the Claude Code CLI at a pinned version, installed at build time; nothing is fetched at run
time), sets `OAX_DEMO_LLM_TOKEN_FILE=/run/secrets/claude-oauth-token` and gives the worker outbound
access to the Anthropic API. The token is read at spawn time, handed to the CLI process only with an
isolated `HOME`, and scrubbed from everything the harness returns; the API container never sees it.
On Kubernetes mount a Secret as a file the same way (`OAX_DEMO_LLM_TOKEN_FILE`).

### Verified for real

See [`verification/demo-claude-mode.md`](verification/demo-claude-mode.md): a visitor request, a
worker run through the real CLI, policy-gated tool calls, cost and audit chain.

## Tests

- API: scenario endpoints, rate limits, daily caps, budget and concurrency in `claude-code` mode.
- Worker: `DemoLlmRunner` with a recording harness (fixed data, forged-event protection, budget
  caps, non-demo runs untouched, setup failures).
- UI: the dashboard card (simulated and live labels, limit errors); the guided tour (steps,
  persistence incl. blocked storage, auto-start rules, restart, keyboard and focus, spotlight
  fallback, en/de).
- Opt-in real run: `OAX_TEST_CLAUDE=1 pnpm vitest run apps/worker/test/demo-llm.integration.test.ts`.
