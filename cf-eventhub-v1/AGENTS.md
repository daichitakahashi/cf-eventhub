# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## Testing Policy

### Unit Tests

Use unit tests for behavior that belongs to a single module and can be specified
purely by its inputs and outputs. This includes routing condition evaluation,
batch splitting, retry state transitions, SQL selection rules, and ULID
generation behavior.

### Integration Tests

Use integration tests for behavior that only becomes meaningful when multiple
modules are composed through the Durable Object runtime. This includes
`publish()` persistence and delivery flow, `waitUntil()` completion effects,
alarm-driven retries, and alarm rescheduling.

### Choosing the Test Layer

When deciding where a test should live, use this rule: if a failure can be
localized to one file or one module contract, prefer a unit test; if the
behavior depends on Durable Object storage, alarms, queue bindings, or the
interaction between `eventhub.ts`, `store.ts`, and `queue.ts`, prefer an
integration test.

Prefer unit tests for boundary values and branching logic. Prefer integration
tests for end-to-end state transitions. Avoid duplicating the same assertion
heavily at both layers unless the behavior is operationally critical.

### Test Comments

Add a short English comment at the start of a test case only when the flow is
not obvious from the test name and body alone. Use a numbered list of steps for
tests involving stubs, mocks, Durable Object state, alarms, async callbacks, or
multi-step state transitions, where setup and verification can otherwise be hard
to follow. Skip this comment for simple stateless input/output tests unless the
extra explanation materially improves readability.

### Refactor Rule

Re-evaluate test placement whenever a refactor changes a function's
responsibility or dependency boundary. A test that was previously appropriate as
a unit test may need to move to integration coverage if the behavior now depends
on Durable Object storage, alarms, queue bindings, async orchestration, or
cross-module coordination. The inverse also applies: if behavior becomes
localized to one module again, prefer moving coverage down to a unit test.

Do not preserve an existing test layer by inertia. For every meaningful
responsibility change, explicitly decide whether the behavior is still best
verified as a unit test or should now be verified as an integration test.
