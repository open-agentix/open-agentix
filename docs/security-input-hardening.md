# Input hardening: what reaches the model

Two cheap, deterministic stages run on every text that enters a model's context or a stored step
output. They complement the structural rule that tool results and event payloads are untrusted data
and never instructions; they do not replace it, and they are not a prompt-injection detector.

| Stage | What it does | Setting (default on) |
| --- | --- | --- |
| Invisible-Unicode filter | removes characters a human cannot see but a model reads | `OAX_STRIP_INVISIBLE_UNICODE` |
| Secret redaction | replaces secret values with `[redacted:<kind>]` | `OAX_REDACT_MODEL_CONTEXT` |

Code: `packages/core/src/invisible-text.ts`, `secret-patterns.ts`, `context-guard.ts`.

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
| `bidi` | U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069 |
| `tag` | U+E0000-U+E007F (the "tag" block used to hide whole sentences) |
| `variation` | U+E0100-U+E01EF (variation selectors supplement, used to smuggle bytes); U+FE00-U+FE0F except the first one after a visible character (see below) |
| `control` | C0 and C1 control codes and DEL, except tab, line feed and carriage return |
| `format` | other characters that render as nothing: U+00AD (soft hyphen), U+034F, U+115F, U+1160, U+3164, U+FFA0 (Hangul fillers), U+17B4, U+17B5, U+180E, U+206A-U+206F, U+FFF9-U+FFFB (interlinear annotation), U+1BCA0-U+1BCA3, U+1D173-U+1D17A |

**Variation selectors (decision).** U+FE00-U+FE0F are how emoji presentation (U+FE0F), text
presentation (U+FE0E), keycaps and standardized variants are written: one selector after a visible
character. A run of them is the byte-smuggling trick (one selector per nibble or byte attached to a
single emoji), so only the first selector after a visible character stays; one at the start of the
text or after another selector is removed. The residual channel is one hidden nibble per visible
character, accepted like the joiner channel below. Removing the tag block also turns the
subdivision flags (England, Scotland, Wales) into a plain black flag, and the ideographic variation
sequences (U+E0100-U+E01EF after a CJK character) fall back to the default glyph; both are accepted.

**Joiners (decision).** ZWJ (U+200D) and ZWNJ (U+200C) are kept only when both neighbours are
non-ASCII letters, combining marks or emoji (including emoji modifiers and U+FE0F). That keeps
family and profession emoji, Persian text with ZWNJ and Indic conjuncts working, and removes the
abuse cases: a joiner between ASCII letters (`ig<ZWJ>nore`), next to ASCII, digits or punctuation,
at the start or end of a word, and runs of joiners. The residual risk is a very low bandwidth
channel through joiners placed between non-ASCII letters; it is accepted because normal prose
would otherwise break. U+FE0F (emoji presentation) is ordinary text and stays. Text is not
normalised (no NFC), so legitimate text is never rewritten beyond the removed code points.

## Secret redaction

- **Exact values in use**: secrets resolved for MCP servers (the gateway registers every value its
  resolver hands out), brokered credentials and the step's run token on a run node, and the gate
  and model tokens of a harness step. Matched plain, URL-encoded, base64 and base64url at any byte
  alignment (so a value inside a larger encoded blob, such as a docker `auth` field or an encoded
  `.env`, is found too) and hex in either case. Values shorter than 8 characters are not matched exactly (they would mangle ordinary
  text); the token shapes below still apply.
- **Token shapes**: the list in `packages/core/src/secret-patterns.ts`, shared with the
  pull-request secret scan (`apps/worker/src/git/secret-scan.ts`, which fails closed on a hit). A
  private key is replaced as a whole block (a truncated block up to 4 KiB after the header).
- Replacement is `[redacted:<kind>]` (`known-secret`, `github-token`, `private-key`, ...). Heuristic
  kinds (`env-secret-assignment`, `secret-assignment`, `authorization-header`) replace the whole
  match, including the variable name; that over-redacts on purpose.
- Limits: a secret the platform never saw and that has no known shape is not found; an attacker who
  controls a tool can encode a value beyond the decoded forms. This is a tripwire and a hygiene
  measure, not a guarantee.
- All patterns are bounded; the test suite runs them against hostile 256 KiB inputs with a time limit
  and checks that doubling the input does not quadruple the time (a quadratic pattern was found
  once in review).

## Audit

When a stage removes or replaces something, a `control` step named `input_guard` is recorded
(audit action `step.control`, target `input_guard`):

```json
{ "source": "tool_result", "tool": "read_file",
  "invisible": { "total": 3, "classes": { "tag": 2, "zero_width": 1 } },
  "secrets": { "total": 1, "kinds": { "github-token": 1 } } }
```

`source` is `input` (prompt), `tool_result` or `tool_error`; `tool` is the configured tool name. The
entry carries counts and class or kind names only, never the content or a digest of it. A clean
text adds no entry. A run node may report this one control step; the control node reduces whatever
it sends to counts (capped) and the class and kind names the guard itself can produce
(`auditShapeOfReport`), keeps `source` only if it is one of the three values above and `tool` only
if it has the shape of an MCP tool name, and marks the step `reportedBy: node:<id>`, like every node
step. Any other control step from a node is still ignored. A node can still put arbitrary text into
the `tool_call` and `output` steps it is allowed to report; the guard step adds no new channel.

## Configuration

See [configuration](configuration.md#input-hardening). Both stages are on by default. Turning one
off is meant for diagnostics (for example to see the raw text a tool returned). Only `0`, `false`,
`off` or `no` disable a stage; any other value, including a typo, keeps it on. Run nodes read the
same variables from their own environment; a runner that does not pass them leaves both stages on.
