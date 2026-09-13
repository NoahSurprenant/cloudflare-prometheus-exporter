import { z } from "zod";
import type { MetricDefinition } from "./metrics";

/** Query name whose counters use the packed colo storage format. */
export const COLO_METRICS_QUERY_NAME = "colo-metrics";

const STALE_COUNTER_MISSES = 5;

/**
 * Columnar counters for one zone: row `i` is `colo[i]`, `host[i]`, ... .
 * Storing columns instead of objects removes per-row key names, keeping 150k
 * unique zone/colo/host rows under the 16 MiB state guard and 32 MiB RPC cap.
 */
const PackedColoZoneSchema = z
	.object({
		zone: z.string(),
		colo: z.array(z.string()),
		host: z.array(z.string()),
		visits: z.array(z.number()),
		edgeResponseBytes: z.array(z.number()),
		requests: z.array(z.number()),
		misses: z.array(z.number().int().nonnegative()),
		lastIngest: z.array(z.number()),
	})
	.refine(
		(zone) =>
			[
				zone.host,
				zone.visits,
				zone.edgeResponseBytes,
				zone.requests,
				zone.misses,
				zone.lastIngest,
			].every((column) => column.length === zone.colo.length),
		{ message: "Packed colo zone columns must have equal length" },
	);

export const PackedColoMetricStateSchema = z.object({
	format: z.literal("colo-packed-by-zone-v2"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(COLO_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedColoZoneSchema),
});

export type PackedColoZone = z.infer<typeof PackedColoZoneSchema>;
export type PackedColoMetricState = z.infer<typeof PackedColoMetricStateSchema>;

/** Packed value column exported by each Prometheus family. */
export type PackedColoValueColumn = "visits" | "edgeResponseBytes" | "requests";

export const PACKED_COLO_METRIC_FAMILIES: readonly {
	name: string;
	help: string;
	column: PackedColoValueColumn;
}[] = [
	{
		name: "cloudflare_zone_colocation_visits_total",
		help: "Visits per colo",
		column: "visits",
	},
	{
		name: "cloudflare_zone_colocation_edge_response_bytes_total",
		help: "Edge response bytes per colo",
		column: "edgeResponseBytes",
	},
	{
		name: "cloudflare_zone_colocation_requests_total",
		help: "Requests per colo",
		column: "requests",
	},
];

type ObservedRow = {
	zone: string;
	colo: string;
	host: string;
	visits: number;
	edgeResponseBytes: number;
	requests: number;
};

function rowKey(zone: string, colo: string, host: string): string {
	return `${zone}\x00${colo}\x00${host}`;
}

function observeWindow(
	metrics: readonly MetricDefinition[],
): Map<string, ObservedRow> {
	const observed = new Map<string, ObservedRow>();
	for (const metric of metrics) {
		const family = PACKED_COLO_METRIC_FAMILIES.find(
			(f) => f.name === metric.name,
		);
		if (family === undefined) continue;
		for (const { labels, value } of metric.values) {
			const zone = labels.zone ?? "";
			const colo = labels.colo ?? "";
			const host = labels.host ?? "";
			const key = rowKey(zone, colo, host);
			const row = observed.get(key) ?? {
				zone,
				colo,
				host,
				visits: 0,
				edgeResponseBytes: 0,
				requests: 0,
			};
			row[family.column] += value;
			observed.set(key, row);
		}
	}
	return observed;
}

function emptyZone(zone: string): PackedColoZone {
	return {
		zone,
		colo: [],
		host: [],
		visits: [],
		edgeResponseBytes: [],
		requests: [],
		misses: [],
		lastIngest: [],
	};
}

function pushRow(
	target: PackedColoZone,
	row: Omit<ObservedRow, "zone">,
	misses: number,
	lastIngest: number,
): void {
	target.colo.push(row.colo);
	target.host.push(row.host);
	target.visits.push(row.visits);
	target.edgeResponseBytes.push(row.edgeResponseBytes);
	target.requests.push(row.requests);
	target.misses.push(misses);
	target.lastIngest.push(lastIngest);
}

/**
 * Accumulate one query window into packed colo counters.
 * Replaying the same `ingestId` is idempotent; rows unseen for five windows expire.
 * Rows in `failedScopes` (zones whose query failed) are neither aged nor expired.
 */
export function accumulatePackedColoRows(
	previous: PackedColoMetricState | undefined,
	metrics: readonly MetricDefinition[],
	ingestId: number,
	failedScopes: ReadonlySet<string>,
): PackedColoZone[] {
	const ageMissing = previous?.lastIngest !== ingestId;
	const observed = observeWindow(metrics);
	const next = new Map<string, PackedColoZone>();
	const zoneFor = (zone: string): PackedColoZone => {
		const existing = next.get(zone);
		if (existing !== undefined) return existing;
		const created = emptyZone(zone);
		next.set(zone, created);
		return created;
	};

	for (const bucket of previous?.zones ?? []) {
		const target = zoneFor(bucket.zone);
		for (let i = 0; i < bucket.colo.length; i++) {
			const colo = bucket.colo[i] ?? "";
			const host = bucket.host[i] ?? "";
			const stored = {
				colo,
				host,
				visits: bucket.visits[i] ?? 0,
				edgeResponseBytes: bucket.edgeResponseBytes[i] ?? 0,
				requests: bucket.requests[i] ?? 0,
			};
			const misses = bucket.misses[i] ?? 0;
			const lastIngest = bucket.lastIngest[i] ?? 0;
			const key = rowKey(bucket.zone, colo, host);
			const seen = observed.get(key);
			if (seen !== undefined) {
				observed.delete(key);
				// Retries can replay the same Cloudflare window; only add it once.
				const skip = lastIngest === ingestId;
				pushRow(
					target,
					{
						colo,
						host,
						visits: stored.visits + (skip ? 0 : seen.visits),
						edgeResponseBytes:
							stored.edgeResponseBytes + (skip ? 0 : seen.edgeResponseBytes),
						requests: stored.requests + (skip ? 0 : seen.requests),
					},
					STALE_COUNTER_MISSES,
					ingestId,
				);
			} else if (!ageMissing || failedScopes.has(bucket.zone)) {
				pushRow(target, stored, misses, lastIngest);
			} else if (misses > 1) {
				pushRow(target, stored, misses - 1, lastIngest);
			}
		}
	}

	for (const row of observed.values()) {
		pushRow(zoneFor(row.zone), row, STALE_COUNTER_MISSES, ingestId);
	}

	return [...next.values()].filter((zone) => zone.colo.length > 0);
}
