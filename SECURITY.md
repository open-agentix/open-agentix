# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

Until 1.0.0 only the latest minor release receives security fixes.

## Reporting a vulnerability

**Please do not open public issues for security problems.**

Report privately via
[GitHub Security Advisories](https://github.com/open-agentix/platform/security/advisories/new)
("Report a vulnerability"). Include affected version, a description, reproduction steps and the
impact you expect. We acknowledge reports within 3 working days and aim to ship a fix for
critical issues within 14 days. We coordinate disclosure with you and credit you in the advisory
unless you prefer otherwise.

## Scope

In scope: the API, worker, runners, policy engine, audit chain, provider/MCP/event adapters,
container images and the default configuration in this repository.

Particularly interesting:

- bypasses of the policy engine (tool allowlist, argument constraints, approvals),
- tampering with the audit trail that `verify` does not detect,
- privilege escalation across roles or teams (RBAC),
- secret leakage into prompts, logs, audit payloads or API responses,
- webhook signature or replay-protection bypasses,
- server-side request forgery through provider, MCP or connection configuration.

## Hardening defaults

- Containers run as non-root with a read-only root file system.
- Outbound calls only to configured providers, MCP servers and event sources; no run-time
  downloads of prompts, skills or tools.
- Secrets are referenced by name (environment or Kubernetes Secret) and redacted in logs and
  audit payloads.
- The audit table is append-only (trigger + database role without UPDATE/DELETE).
