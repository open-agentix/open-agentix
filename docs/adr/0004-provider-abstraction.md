# ADR 0004: Provider abstraction incl. Bedrock VPC endpoints and proxies

- Status: Accepted
- Date: 2026-10-03

## Context

Enterprises run models in different places: AWS Bedrock inside a VPC without internet access,
Azure OpenAI, self-hosted vLLM/Ollama, Anthropic directly. Tests and the public demo must not call
any model at all.

## Decision

- One interface `ModelProvider.complete(ChatRequest) -> ChatResponse` with normalised messages,
  tool calls, usage and stop reasons. Each provider declares a **clearance** (highest data
  classification it may receive); the control agent blocks runs whose data is more sensitive.
- Adapters: **OpenAI-compatible** (OpenAI, Azure via headers/query, vLLM, LM Studio), **Ollama**,
  **Anthropic** (official SDK), **AWS Bedrock** (SDK v3 Converse API), **simulated** (scripted,
  deterministic, templated from the event; used by tests and the demo).
- **Network calls only to configured endpoints**: HTTP adapters use a guarded fetch that rejects
  any other origin; optional HTTPS proxy via undici `ProxyAgent`.
- **Bedrock**: configurable `endpoint` for **VPC interface endpoints**
  (`https://vpce-….bedrock-runtime.<region>.vpce.amazonaws.com`), HTTPS proxy via
  `NodeHttpHandler` + `https-proxy-agent`, credentials from the **default AWS provider chain**
  (IRSA on EKS via `AWS_WEB_IDENTITY_TOKEN_FILE`/`AWS_ROLE_ARN`, ECS/EC2 roles, SSO) – no keys in
  configuration.
- Secrets (API keys) are **references** resolved from env (`OAX_SECRET_<NAME>`) or mounted files.
- Prices come from a configurable price table (micro-USD per million tokens); local providers are free.

## Consequences

- Adding a provider is one adapter plus tests with mocks; no network in tests.
- Provider-specific features (prompt caching, thinking settings) are not exposed in v0.1; they
  can be added as typed per-provider options without changing the interface.

## Alternatives considered

- LiteLLM proxy as the only gateway: extra Python service, weaker typing; users can still point
  the OpenAI-compatible adapter at one.
- Vendor SDKs for every provider: heavier dependency tree; we use SDKs where they add value
  (Anthropic, Bedrock signing).
