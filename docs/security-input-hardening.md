# Input hardening: what reaches the model

A cheap, deterministic stage runs on every text that enters a model's context or a stored step
output. It complements the structural rule that tool results and event payloads are untrusted data
and never instructions; it does not replace it, and it is not a prompt-injection detector.

| Stage | What it does | Setting (default on) |
| --- | --- | --- |
| Invisible-Unicode filter | removes characters a human cannot see but a model reads | `OAX_STRIP_INVISIBLE_UNICODE` |

Code: `packages/core/src/invisible-text.ts`, `context-guard.ts`.

## Where it runs (the choke points)

1. **Tool results: `ToolGateway.call`** (`packages/mcp/src/gateway.ts`). Every tool call of every
   runner passes this method: inline runs, the harness gate (`serveGateHttp`) and run nodes (each
   node has its own gateway). The result text (and `structured` content) is guarded before the
   caller sees it, so the model context and the stored `tool_call` step output both carry the
   guarded text. Tool error messages are guarded in the executor.
2. **Prompts: `executePipeline` / `executeWithHarness`**. The finished first prompt (event data,
   handed-over input, previous agent output) is guarded once, where all of them meet.

Not covered (stated honestly): text that a harness produces *inside* its own process (for example
the output of a shell command Claude Code runs itself) and reaches the model through the model
proxy. Harness steps run with the workspace and gate tools only; guarding the model proxy request
is a possible follow-up. Model output is not rewritten.

## Invisible Unicode

Removed always:

| Class (audit name) | Code points |
| --- | --- |
| `zero_width` | U+200B, U+2060-U+2064, U+FEFF |
| `bidi` | U+200E, U+200F, U+202A-U+202E, U+2066-U+2069 |
| `tag` | U+E0000-U+E007F (the "tag" block used to hide whole sentences) |
| `variation` | U+E0100-U+E01EF (variation selectors supplement, used to smuggle bytes) |
| `control` | C0 and C1 control codes and DEL, except tab, line feed and carriage return |

**Joiners (decision).** ZWJ (U+200D) and ZWNJ (U+200C) are kept only when both neighbours are
non-ASCII letters, combining marks or emoji (including emoji modifiers and U+FE0F). That keeps
family and profession emoji, Persian text with ZWNJ and Indic conjuncts working, and removes the
abuse cases: a joiner between ASCII letters (`ig<ZWJ>nore`), next to ASCII, digits or punctuation,
at the start or end of a word, and runs of joiners. The residual risk is a very low bandwidth
channel through joiners placed between non-ASCII letters; it is accepted because normal prose
would otherwise break. U+FE0F (emoji presentation) is ordinary text and stays. Text is not
normalised (no NFC), so legitimate text is never rewritten beyond the removed code points.

## Audit

When the filter removes something, a `control` step named `input_guard` is recorded
(audit action `step.control`, target `input_guard`):

```json
{ "source": "tool_result", "tool": "read_file",
  "invisible": { "total": 3, "classes": { "tag": 2, "zero_width": 1 } } }
```

`source` is `input` (prompt), `tool_result` or `tool_error`; `tool` is the configured tool name. The
entry carries counts and class names only, never the content or a digest of it. A clean
text adds no entry. A run node may report this one control step; the control node reduces whatever
it sends to counts and class names matching `[a-z0-9_-]{1,40}` (`auditShapeOfReport`) and marks it
`reportedBy: node:<id>`, like every node step. Any other control step from a node is still ignored.

## Configuration

See [configuration](configuration.md#input-hardening). The filter is on by default. Turning it
off is meant for diagnostics (for example to see the raw text a tool returned). Only `0`, `false`,
`off` or `no` disable it; any other value, including a typo, keeps it on. Run nodes read the
same variable from their own environment; a runner that does not pass it leaves the filter on.
