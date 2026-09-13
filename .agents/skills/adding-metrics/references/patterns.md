# Code Patterns

Copy-paste templates for the most common metric implementation patterns.

## Account-Level Handler (from PR #15: network-analytics)

```typescript
private async getMyNewMetrics(
    accountId: string,
    normalizedAccount: string,
    timeRange: { mintime: string; maxtime: string },
): Promise<MetricDefinition[]> {
    const result = await this.gql.query(MyNewQuery, {
        accountID: accountId,
        mintime: timeRange.mintime,
        maxtime: timeRange.maxtime,
        limit: this.config.queryLimit,
    });

    if (result.error) {
        this.logger.error("GraphQL error (my-new-metric)", {
            error: result.error.message,
        });
        return [];
    }

    const myMetric: MetricDefinition = {
        name: "cloudflare_my_scope_thing_total",
        help: "Description of what this measures",
        type: "counter",  // or "gauge"
        values: [],
    };

    for (const accountData of result.data?.viewer?.accounts ?? []) {
        for (const group of accountData.someDatasetGroups ?? []) {
            const dims = group.dimensions;
            if (dims == null) continue;

            myMetric.values.push({
                labels: {
                    account: normalizedAccount,
                    outcome: dims.outcome ?? "",
                    direction: dims.direction ?? "",
                },
                value: group.sum?.bits ?? 0,
            });
        }
    }

    return [myMetric].filter((m) => m.values.length > 0);
}
```

## Zone-Level Handler (from existing adaptive-metrics pattern)

```typescript
private async getMyZoneMetrics(
    zoneIds: string[],
    zones: Zone[],
    timeRange: TimeRange,
): Promise<MetricDefinition[]> {
    const result = await this.gql.query(MyZoneQuery, {
        zoneIDs: zoneIds,
        mintime: timeRange.mintime,
        maxtime: timeRange.maxtime,
        limit: this.config.queryLimit,
    });

    if (result.error) {
        throw new Error(`GraphQL error: ${result.error.message}`);
    }

    const myMetric: MetricDefinition = {
        name: "cloudflare_zone_my_thing_total",
        help: "Description",
        type: "counter",
        values: [],
    };

    for (const zoneData of result.data?.viewer?.zones ?? []) {
        const zoneName = findZoneName(zoneData.zoneTag, zones);

        for (const group of zoneData.someAdaptiveGroups ?? []) {
            const dims = group.dimensions;
            if (dims == null) continue;

            myMetric.values.push({
                labels: {
                    zone: zoneName,
                    status: String(dims.edgeResponseStatus ?? 0),
                    country: dims.clientCountryName ?? "",
                },
                value: group.count ?? 0,
            });
        }
    }

    return [myMetric].filter((m) => m.values.length > 0);
}
```

## Shared Extraction Helper (from PR #15: multiple datasets with same shape)

When multiple datasets share `sum { bits, packets }` + common dimensions, use a generic helper:

```typescript
private collectDataset<
    T extends {
        sum?: { bits: number; packets: number } | null;
        dimensions?: { outcome: string; direction: string; ipProtocolName: string } | null;
    },
>(
    groups: readonly T[],
    slug: string,
    helpPrefix: string,
    normalizedAccount: string,
    metrics: MetricDefinition[],
    extraLabels?: (dims: NonNullable<T["dimensions"]>) => Record<string, string>,
): void {
    if (groups.length === 0) return;

    const bits: MetricDefinition = {
        name: `cloudflare_network_analytics_${slug}_bits_total`,
        help: `${helpPrefix} bits received`,
        type: "counter",
        values: [],
    };
    const packets: MetricDefinition = {
        name: `cloudflare_network_analytics_${slug}_packets_total`,
        help: `${helpPrefix} packets received`,
        type: "counter",
        values: [],
    };

    for (const group of groups) {
        const dims = group.dimensions;
        if (dims == null) continue;

        const labels: Record<string, string> = {
            account: normalizedAccount,
            outcome: dims.outcome ?? "",
            direction: dims.direction ?? "",
            ip_protocol: dims.ipProtocolName ?? "",
            ...extraLabels?.(dims as NonNullable<T["dimensions"]>),
        };

        bits.values.push({ labels, value: group.sum?.bits ?? 0 });
        packets.values.push({ labels, value: group.sum?.packets ?? 0 });
    }

    metrics.push(bits, packets);
}
```

## Switch Wiring (both dispatch methods)

```typescript
// In getAccountMetrics() or getZoneMetrics():
case "my-new-metric":
    return this.getMyNewMetrics(accountId, normalizedAccount, timeRange);
// ...
default: {
    const _exhaustive: never = query;
    throw new Error(`Unknown metric query: ${_exhaustive}`);
}
```

## Metric Naming Conventions

| Pattern | Example | When |
|---------|---------|------|
| `cloudflare_zone_<thing>_total` | `cloudflare_zone_requests_total` | Zone-scoped counter |
| `cloudflare_zone_<thing>_seconds` | `cloudflare_zone_health_check_rtt_seconds` | Duration gauge |
| `cloudflare_zone_<thing>_rate` | `cloudflare_zone_origin_error_rate` | Ratio gauge |
| `cloudflare_worker_<thing>_total` | `cloudflare_worker_requests_total` | Worker counter |
| `cloudflare_magic_transit_<thing>` | `cloudflare_magic_transit_active_tunnels` | MT gauge |
| `cloudflare_network_analytics_<sys>_<unit>_total` | `cloudflare_network_analytics_dosd_bits_total` | NAv2 counter |

## Label Naming

Always `snake_case`. Common labels:

| Label | Scope | Notes |
|-------|-------|-------|
| `account` | account-level | Via `normalizeAccountName()` |
| `zone` | zone-level | Via `findZoneName()` |
| `status` | zone HTTP | `String(dims.edgeResponseStatus ?? 0)` |
| `country` | zone HTTP | `dims.clientCountryName ?? ""` |
| `host` | zone HTTP | `dims.clientRequestHTTPHost ?? ""` |
| `outcome` | network analytics | `"pass"` or `"drop"` |
| `direction` | network analytics | `"inbound"` or `"outbound"` |
| `ip_protocol` | network analytics | `"tcp"`, `"udp"`, etc. |
