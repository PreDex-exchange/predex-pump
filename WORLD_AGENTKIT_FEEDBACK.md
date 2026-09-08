# World AgentKit integration feedback

Status: SDK integration and automated end-to-end tests complete; live AgentBook registration and
World ID Sandbox observations will be added after the interactive verification step.

## AgentKit documentation and integration

What worked well:

- The quickstart clearly explains the intended client behavior: AgentKit tries human-backed access
  first and leaves the existing x402 payment fallback intact.
- The low-level parser, message validator, signature verifier, and AgentBook verifier made it
  possible to integrate with an existing Fastify/Circle payment path without replacing it.
- The storage contract correctly calls out that usage increments must be atomic and that in-memory
  storage is unsuitable for production.

What was confusing or missing:

- The quickstart's concrete server example emphasizes Hono and World Chain/Base payments, while the
  SDK supports generic `eip155:*` signatures and framework adapters. A short Fastify/manual example
  and an explicit statement that the payment chain and AgentBook lookup chain are independent would
  make this much easier to discover.
- `createAgentkitClient` discovers the extension from the JSON 402 body, while x402 clients often
  consume the canonical `PAYMENT-REQUIRED` header. Custom servers need to know that the enriched
  challenge must be present in the body as well as the header.
- The documented validation helper describes resource binding, but exact path binding is not
  obvious. Continuity added an explicit full-URI comparison before granting a metered resource.
- A free-trial grant needs quota consumption and nonce replay protection to succeed atomically.
  The two separate `AgentKitStorage` methods do not show how a custom server should avoid consuming
  one without the other under concurrency. A transactional reference adapter would help.

## Developer Portal navigation and product discovery

Pending the interactive AgentBook/Sandbox step. We will record the path taken, search terms used,
and any mismatch between the portal and AgentKit CLI guidance rather than inventing feedback.

## World ID Sandbox states and proof flow

The pinned official AgentKit CLI `0.2.0` generated a `world.org/verify` QR/deep link and waited for
five minutes, but it exposes no Sandbox option and its packaged source hard-codes the registration
app ID. The separate Sandbox documentation says integrations should select `environment: sandbox`
in IDKit. It is unclear how an AgentKit CLI registration is expected to satisfy the ETHOnline
requirement to use the Sandbox App. An explicit `--environment sandbox` flag—or track guidance that
the Sandbox App can consume this production-shaped bridge request—would remove the ambiguity.

Two remote CLI waits expired without changing AgentBook state because no mobile verification was
completed. A fresh verification attempt is pending; the final notes will record QR handoff,
test-user state, success/error recovery, and remote verification behavior without treating a
failed or production-only flow as Sandbox evidence.

## Debugging and edge cases exercised

Automated coverage includes malformed headers, wrong domain, wrong resource, expired challenges,
bad signatures, unregistered agents, AgentBook timeout, shared-human quotas, concurrent requests,
replayed nonces, process restart, and the fourth-request Circle fallback. Logs deliberately omit
the AgentKit header, signature, nonce, and raw anonymous human identifier.
