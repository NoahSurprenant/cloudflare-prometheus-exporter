# Workflow: Adding Metrics

Step-by-step checklists per metric category. Each step references exact files and code locations.

## 0. Schema Discovery (all categories)

Before writing code, verify the data source exists:

1. **GraphQL**: Check `src/cloudflare/gql/schema.gql` for the dataset name (e.g. `httpRequestsAdaptiveGroups`, `magicTransitNetworkAnalyticsAdaptiveGroups`). Look at available `dimensions`, `sum`, `avg`, `count` fields.
2. **REST**: Check the [Cloudflare API docs](https://developers.cloudflare.com/api/) or the `cloudflare` SDK types.
3. **Decide counter vs gauge**: Window totals (requests, bytes, packets) = counter. Snapshots, rates, durations, statuses = gauge.
4. **Assess label cardinality**: Avoid IPs, ports, UUIDs, request paths. Prefer: status codes, countries, protocol names, boolean states, enum values.

## Step A: Account-Level GraphQL Metric

Examples: `worker-totals`, `magic-transit`, `network-analytics`, `logpush-account`

### A1. Define GraphQL query

**File**: `src/cloudflare/gql/queries.ts`

Add a new `graphql()` tagged template. Account queries use `$accountID: string!` (singular):

```typescript
export const MyNewQuery = graphql(`
  query MyNewMetrics($accountID: string!, $limit: uint64!, $mintime: Time!, $maxtime: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        someDatasetAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum { bits packets }
          dimensions { outcome direction ipProtocolName }
        }
      }
    }
  }
`);
```

### A2. Register query name

**File**: `src/cloudflare/queries.ts`

Add to three places:
- `MetricQueryNameSchema` z.enum array (under `// Account-level`)
- `ACCOUNT_LEVEL_QUERIES` array
- `FREE_TIER_QUERIES` array (if available on free tier -- most account-level queries are)

### A3. Implement handler + wire switch

**File**: `src/cloudflare/client.ts`

1. Import the query: `import { MyNewQuery } from "./gql/queries";`
2. Add case to `getAccountMetrics()` switch (before `default`)
3. Implement private handler method (see patterns.md for template)

### A4. Verify

```bash
npx tsc --noEmit   # exhaustive switch catches missing cases
bun run check       # biome lint + format
```

### A5. Update README

- Add metrics table under `## Available Metrics`
- Update exporter count in architecture diagram (`(N)` in ASCII art)
- Update query count in `Query Types (N total)` section

---

## Step B: Zone-Level GraphQL Metric

Examples: `http-metrics`, `adaptive-metrics`, `colo-metrics`, `edge-country-metrics`

### B1. Define GraphQL query

**File**: `src/cloudflare/gql/queries.ts`

Zone queries use `$zoneIDs: [string!]` (plural) and return `zoneTag` for label resolution:

```typescript
export const MyNewZoneQuery = graphql(`
  query MyNewZoneMetrics($zoneIDs: [string!], $mintime: Time!, $maxtime: Time!, $limit: uint64!) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        someAdaptiveGroups(limit: $limit, filter: { datetime_geq: $mintime, datetime_lt: $maxtime }) {
          count
          dimensions { ... }
        }
      }
    }
  }
`);
```

### B2. Register query name

**File**: `src/cloudflare/queries.ts`

Add to three places:
- `MetricQueryNameSchema` z.enum array (under `// Zone-level`)
- `ZONE_LEVEL_QUERIES` array
- `PAID_TIER_GRAPHQL_QUERIES` array (if requires paid tier -- most zone GraphQL queries do)

### B3. Implement handler + wire switch

**File**: `src/cloudflare/client.ts`

1. Import the query
2. Add case to `getZoneMetrics()` switch (before `default`)
3. Implement handler -- uses `findZoneName(zoneData.zoneTag, zones)` for zone labels

Zone chunking (max 10 zones per call) is handled automatically by MetricExporter DO.

### B4-B5. Same as A4-A5.

---

## Step C: REST API Metric (Zone-Scoped DO)

Examples: `ssl-certificates`, `lb-weight-metrics`

REST metrics run in per-zone DOs (not batched). Requires extra wiring.

### C1. Register query name

**File**: `src/cloudflare/queries.ts`

- `MetricQueryNameSchema` z.enum array
- `ZONE_LEVEL_QUERIES` array
- Do **NOT** add to `PAID_TIER_GRAPHQL_QUERIES`

### C2. Implement public single-zone method

**File**: `src/cloudflare/client.ts`

```typescript
public async getMyMetricForZone(zone: Zone): Promise<MetricDefinition[]> { ... }
```

Also implement a private batched version and wire it into `getZoneMetrics()` switch.

### C3. Wire MetricExporter DO

**File**: `src/durable-objects/MetricExporter.ts`

Add case to `fetchZoneScopedMetrics()` switch. This switch is NOT exhaustive (plain string comparison), so TS won't catch missing cases.

### C4-C5. Same as A4-A5.
