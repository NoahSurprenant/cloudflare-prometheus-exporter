---
name: adding-metrics
description: Add new Prometheus metrics to the Cloudflare exporter. Use when adding metrics, implementing new GraphQL/REST queries, or extending metric coverage. Covers the full workflow from schema discovery through client implementation and README updates.
---

# Adding Metrics

Guided workflow for adding new Prometheus metrics to the Cloudflare Prometheus Exporter. Derived from patterns in PRs #10, #13, #14, #15, and opencode session `1770403408223-happy-garden`.

## Decision Tree

```
What kind of metric are you adding?
|
+-- Uses Cloudflare GraphQL API?
|   |
|   +-- Scoped to a single account (no zones)?
|   |   -> Account-level GraphQL
|   |   -> See workflow.md, Step A
|   |
|   +-- Scoped to zones (needs zoneTag_in)?
|       -> Zone-level GraphQL
|       -> See workflow.md, Step B
|
+-- Uses Cloudflare REST API?
    -> REST API (zone-scoped DO)
    -> See workflow.md, Step C
```

## Quick Reference: Files to Modify

| Step | File | Change |
|------|------|--------|
| 1 | `src/cloudflare/gql/queries.ts` | Add `graphql()` tagged template (skip for REST) |
| 2 | `src/cloudflare/queries.ts` | Add to `MetricQueryNameSchema` enum + category arrays |
| 3 | `src/cloudflare/client.ts` | Import query, add switch case, implement handler |
| 4 | `src/durable-objects/MetricExporter.ts` | Only if special guardrails needed (e.g. allowlists) |
| 5 | `README.md` | Add metric docs + update architecture diagram counts |

## Key Conventions

- **Metric names**: `cloudflare_<scope>_<thing>_<unit>` -- `_total` for counters, `_seconds` for durations
- **Label keys**: `snake_case` always. Normalize accounts via `normalizeAccountName()`, zones via `findZoneName()`
- **Counter vs Gauge**: counters for window totals (DO accumulates); gauges for snapshots/rates/ratios
- **Null safety**: `noUncheckedIndexedAccess` is on -- null-coalesce everything: `dims?.field ?? ""`
- **Empty filter**: Always `return [...metrics].filter(m => m.values.length > 0)`
- **Exhaustive switch**: Both dispatch methods use `const _exhaustive: never = query` -- TS errors if case missing

## Reading Order

| Task | Files |
|------|-------|
| Add a metric (full workflow) | workflow.md |
| Copy/paste code templates | patterns.md |
| Avoid known pitfalls | gotchas.md |

## In This Reference

| File | Purpose |
|------|---------|
| [workflow.md](./references/workflow.md) | Step-by-step checklist per metric category |
| [patterns.md](./references/patterns.md) | Code templates for queries, handlers, and MetricDefinitions |
| [gotchas.md](./references/gotchas.md) | Pitfalls from real PRs and code reviews |
