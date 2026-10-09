# Agent instructions for open-agentix

See README for other guidelines.

## Code quality and maintainability

Applies to all new code and modifications. Goals: maintainable code, low coupling, high cohesion, minimal dependencies, clear separation of concerns, easy testing, predictable architecture, consistent English codebase, proper i18n, long-term maintainability.

**General principles:** Prefer simple over clever; composition over inheritance; loosely coupled, highly cohesive modules; Single Responsibility; business logic independent from UI/infrastructure where practical; no unnecessary abstractions or design patterns; no premature optimisation; explicit over implicit; minimal dependencies; never duplicate business logic.

**Refactor-on-touch:** Inspect surrounding code when modifying; fix violations if safely possible; do not preserve bad patterns merely because they exist; no unrelated repository-wide refactoring; keep refactoring and functional changes separable.

**Functions:** Preferred ≤30 lines, warning at 50. Extract when: multiple responsibilities, independent purpose, nameable, independently testable, reused, or mixed abstraction levels. Options object over >4 parameters. Top-level function should read like a high-level description.

**Files:** Preferred max ~250 lines, warning at 400. Review for multiple responsibilities, mixed abstraction levels, repeated logic, business logic in inappropriate places, or utility dumping. Split by responsibility and cohesion, not line count.

**Nesting and control flow:** Max 3 levels. Guard clauses and early returns. Avoid clever one-liners that hurt readability.

**React:** Components describe UI composition; no substantial business logic inside. Extract: API access → services, business logic → domain functions, reusable logic → custom hooks, transformations → pure functions, complex UI → child components, forms → dedicated hooks. Component size ≤150 lines preferred, warning >250.

**Business logic:** Framework-independent where practical. Layering: UI → Hook/Controller → Application Service → Domain → Infrastructure. Pure TypeScript functions where possible.

**Node.js backend:** Separate responsibilities (routes, controllers, services, domain, repositories, infrastructure). Controllers thin: validate/parse, call application logic, map result. Business rules not in controllers. Split god services.

**Dependencies:** Minimise. Before adding: stdlib possible? maintained? widely used? transitive footprint? security/licence risk? substantial enough? No dependency for trivial functionality; prefer existing project dependencies; no overlapping libraries.

**Utilities:** No `utils.ts`/`helpers.ts`/`misc.ts`/`common.ts` dumping grounds; name by domain (`date/formatDate.ts`, `auth/permissions.ts`).

**DRY, but not excessively:** No duplicated meaningful business logic, but "duplication is cheaper than the wrong abstraction". Extract when conceptually the same, changes together, clearly nameable, reduces complexity.

**Naming:** All identifiers in English (variables, functions, classes, types, interfaces, components, hooks, files, folders, API models). Descriptive names that communicate intent.

**Comments:** English; explain why, constraints, non-obvious decisions, workarounds; not the obvious; remove outdated comments.

**i18n:** All user-facing text through the project's i18n system, never hard-coded. Keys stable, descriptive, hierarchical (`profile.saveChanges`, `errors.networkUnavailable`); never use translated strings as logic identifiers.

**Error handling:** Explicit, meaningful errors; never silently swallow; no bare `console.log(error)`; typed/domain errors where useful; separate user-facing messages, developer diagnostics, and internal details.

**Logging:** Useful context. Never log passwords, access tokens, API keys, secrets, or sensitive personal information.

**Testing:** Business logic independently testable: pure functions, domain logic, application services without browser, React rendering, real database or real external API. Do not mock everything by default.

**Architecture:** Organise by feature/domain when large enough (`features/users/{components,hooks,services,types.ts,validation.ts}`) rather than a giant global structure; a global structure is fine for genuinely shared infrastructure.

**Dependency direction:** Inward towards stable business logic: UI → Application → Domain; Infrastructure → Application/Domain. Domain logic must not depend directly on framework-specific libraries unless necessary.

**Dead code:** Remove unused imports, variables, functions, dead components, obsolete feature flags, commented-out implementations. Version control recovers deleted code.

**Magic values:** No unexplained magic numbers/strings; use named domain constants (`MAX_RETRIES`).

**Security:** Never hard-code secrets, API keys, passwords, tokens; use env vars or secret-management mechanism; validate external input; treat external data as untrusted; avoid unsafe dynamic execution.

**API boundaries:** Explicit contracts; do not pass arbitrary objects; validate at boundaries and convert to internal models (External API → Validation → Internal Model).

**Definition of done:** identifiers English, comments English, user-facing text via i18n, no unnecessary dependencies, functions single responsibility, large functions/components evaluated, no duplicated business logic, business logic separated from UI/infrastructure, no hard-coded secrets, errors handled intentionally, dead code removed, touched code improved when safe, tests for important logic, architecture remains easy to understand.
