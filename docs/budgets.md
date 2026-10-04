# Budgets

openagentix limits spending at two levels. Both are hard stops: when a budget is reached, the
agent does not get to spend more.

| Level | Where it is set | Scope |
| --- | --- | --- |
| Per run | `budget:` in the `agents.md` file (tokens, USD, steps, tool calls, timeout) | one run |
| Per month | tenant, use case and team limits (this page) | all runs of the calendar month (UTC) |

## Monthly budgets

| Scope | Set with | Who |
| --- | --- | --- |
| Tenant | `PATCH /v1/tenants/{id}` (`monthlyBudgetUsd`, `null` removes it) | platform operators |
| Use case | `PUT /v1/budgets/use-cases/{useCase}` with `{ "monthlyBudgetUsd": 25 }` | tenant admins (`settings:write`) |
| Team | `PATCH /v1/teams/{id}` (`monthlyBudgetUsd`) | tenant admins |

The use case is the `labels.useCase` value of the agent definition. Spend is read from the cost
ledger: every model call and priced tool call is a ledger line carrying tenant, team and use case.
A budget starts over on the first day of each month (UTC); nothing has to be reset.

Read the budgets, this month's spend and the alerts already raised with `GET /v1/budgets`
(`costs:read`). The costs page of the UI shows the same data and lets admins set and remove use
case budgets.

A limit of `0` blocks every run of the use case. Removing a budget lifts the stop.

## Where the hard stop is enforced

1. **Admission.** When a run is queued (event, schedule, manual start), the control node checks the
   tenant, use case and team budgets. If one is reached, the run is stored as `blocked_by_policy`
   with the error code `tenant_budget_exceeded`, `use_case_budget_exceeded` or
   `team_budget_exceeded`. The audit log gets a `run.blocked` entry that lists the breached budgets.
2. **Mid-run.** The executor asks the control node for the budget verdict before every model call
   and after every tool call (`ControlPlane.checkBudget`, `GET /v1/worker/runs/{id}/budget` for
   remote workers). The verdict covers the spend of **all** runs of the month, so a run stops
   when other runs use up the budget. The control agent turns a breach into a `kill` decision
   (rule `budget_tenant`, `budget_use_case` or `budget_team`); the run ends `failed` with the
   error code `control_budget_<scope>`, and the audit log gets a `budget.blocked` entry for the run.
   Control planes without a ledger (the local CLI) never report a breach.

A budget counts as reached when the spend is **at or above** the limit. The check happens between
steps, so one model call can overshoot the limit by its own cost. Runs that start at the same
moment all pass admission and are stopped at their next step, so a burst can also overshoot.
Size the limit with that margin in mind.

## Alerts

When a recorded cost line makes the spend cross 50, 80 or 100 % of a budget, the cost recorder
raises an alert, once per tenant, scope, month and threshold:

- an event of type `io.openagentix.budget.alert` is stored in `events` (visible in the events list,
  subject `tenant`, `use_case/<name>` or `team/<slug>`), with this data:

  ```json
  {
    "tenantId": "…",
    "scope": "use_case",
    "key": "vulnerability-management",
    "month": "2026-10-01",
    "thresholdPercent": 80,
    "limitUsd": 10,
    "spentUsd": 8.1
  }
  ```

- a `budget.alert` audit entry with the same payload.

The 100 % alert is raised together with the hard stop. Raising a limit after an alert does not
raise the same threshold again in that month. Sending the events to chat or mail is a roadmap
item; until then, alerts are read from the events list, the audit log or the budgets API.

## Audit entries

| Action | When |
| --- | --- |
| `budget.set`, `budget.removed` | a use case budget was changed |
| `tenant.updated` | the tenant limit was changed |
| `run.blocked` | a run was refused at admission (payload names the breached budgets) |
| `budget.blocked` | a running run was stopped (`stage: "run"`) |
| `budget.alert` | an alert threshold was crossed |

## Tenant isolation

Budgets, spend and alerts are scoped to the caller's tenant. A use case budget of one tenant never
affects another tenant, even if both use the same use case label. See [tenancy](tenancy.md).
