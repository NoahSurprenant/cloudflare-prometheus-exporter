# Gotchas

Pitfalls derived from real PRs, code reviews, and opencode sessions in this repo.

## TypeScript Strictness

### noUncheckedIndexedAccess

Every optional chain / indexed access returns `T | undefined`. The compiler enforces this.

```typescript
// WRONG: won't compile
const status = group.dimensions.originResponseStatus;

// RIGHT: null-coalesce everything
const status = group.dimensions?.originResponseStatus ?? 0;

// RIGHT: guard then access
const dims = group.dimensions;
if (dims == null) continue;
const status = dims.originResponseStatus;  // still needs ?? for individual fields
```

### verbatimModuleSyntax

Explicit `type` keyword required for type-only imports:

```typescript
import type { MetricDefinition } from "./metrics";  // type-only
import { mergeMetricDefinitions } from "./metrics";  // value import
```

### No type assertions

Project prohibits `as Type` casts and `!` non-null assertions. Only existing exceptions: `env as Env & OptionalEnvVars` (widening) and `ACCOUNT_LEVEL_QUERIES as readonly string[]` (in type guards).

## Exhaustive Switch Trap

Both `getAccountMetrics()` and `getZoneMetrics()` use:

```typescript
default: {
    const _exhaustive: never = query;
    throw new Error(`Unknown metric query: ${_exhaustive}`);
}
```

Adding a query name to `ACCOUNT_LEVEL_QUERIES` without adding a switch case produces a **compile-time error**. This is intentional -- it prevents forgetting the handler. But it means you cannot partially implement: all three locations (enum, array, switch) must be updated together.

## Free Tier Zone Filtering

**Source**: PR #14, opencode session `happy-garden`

If your zone-level query uses adaptive analytics, add to `PAID_TIER_GRAPHQL_QUERIES`. The MetricExporter DO auto-filters free-tier zones before calling your handler. Forgetting this causes GraphQL errors like `"does not have access to the path"` for free-tier zones.

Conversely, REST API metrics (`ssl-certificates`, `lb-weight-metrics`) must NOT be in `PAID_TIER_GRAPHQL_QUERIES` -- they work on free tier.

## DO Created Even When Disabled

**Source**: opencode session `happy-garden` (Finding #1, HIGH severity)

`AccountMetricCoordinator` creates a MetricExporter DO for every query in `ACCOUNT_SCOPED_QUERIES`, even if the feature is disabled (e.g. `hostname-http-metrics` with empty allowlist). The DO runs alarms every 60s and returns empty.

**Lesson**: If your metric has an enable/disable condition, consider gating DO creation in `AccountMetricCoordinator.refreshZonesAndPushContext()`, not just returning empty from the handler.

## Counter Semantics

Cloudflare API returns **window totals** (e.g. "1234 requests in the last 60s"). The MetricExporter DO accumulates these into monotonically increasing counters.

**Your handler must return the raw window delta**, not a pre-accumulated value. The DO handles accumulation via `processCounters()`.

If you incorrectly return accumulated values from your handler, the DO will double-count.

## GraphQL Response Array Patterns

Always use `?? []` for response arrays:

```typescript
for (const accountData of result.data?.viewer?.accounts ?? []) { ... }
for (const zoneData of result.data?.viewer?.zones ?? []) { ... }
for (const group of accountData.someGroups ?? []) { ... }
```

Datasets that don't apply to an account (e.g. Magic Transit on a non-MT account) return `null` or empty arrays. The `?? []` pattern handles both gracefully.

## Label Cardinality

**Source**: PR #15 design discussion

High-cardinality labels (IPs, ports, ASNs, UUIDs) multiply Prometheus series count exponentially. This project avoids them:

| Safe (low cardinality) | Unsafe (high cardinality) |
|------------------------|--------------------------|
| outcome, direction | ipSourceAddress, ipDestinationAddress |
| ip_protocol, status | sourcePort, destinationPort |
| country, colo_code | attackId, ruleId (unless bounded) |
| method, action | request paths, query strings |

Network analytics (PR #15) explicitly chose `outcome + direction + ip_protocol` over per-IP breakdowns.

Hostname metrics (session `happy-garden`) cap at 50 hostnames via `MAX_HOSTNAME_ALLOWLIST_SIZE`.

## Error Handling Inconsistency

Account-level handlers return `[]` on error (soft fail). Zone-level handlers throw (caught by chunk error handling). Either works -- MetricExporter catches both. But be consistent within your handler category.

## README Architecture Diagram

The ASCII art diagrams contain hardcoded counts:
- `(N)` in the exporter boxes = account-scoped exporter count
- `N+N` in request path = same count + zone-scoped
- `Query Types (N total)` = total query count
- `ACCOUNT-LEVEL (N)` and `ZONE-LEVEL (N)` = per-category counts

These must be updated when adding a new query. PR #15 updated 15->16 in five locations. Search for the old number to find all occurrences.

## Rate Limit Budget

The global rate limiter is 200 req/10s shared across all DOs. Each new query adds ~1 GraphQL call per account per refresh cycle. For accounts with >10 zones, zone-level queries add ~N/10 calls (chunked). Budget roughly: ~160 req/60s per 50-zone account. Adding queries reduces headroom.
