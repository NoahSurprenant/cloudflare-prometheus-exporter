import z from "zod";
import {
	getCloudflareMetricsClient,
	isAccountLevelQuery,
	isZoneLevelQuery,
} from "../cloudflare/client";
import { isPaidTierGraphQLQuery } from "../cloudflare/queries";
import {
	type ChunkedValueStorage,
	deleteChunkedValue,
	loadChunkedValue,
	saveChunkedValue,
} from "./chunked-storage";
import { accumulateCounterMetrics } from "./counters";
import { parseCommaSeparated, partitionZonesByTier } from "./filters";
import { createLogger, type Logger } from "./logger";
import { getMetricRefreshDelaySeconds } from "./metric-refresh";
import {
	type MetricDefinition,
	MetricDefinitionSchema,
	mergeMetricDefinitions,
} from "./metrics";
import {
	accumulatePackedColoRows,
	COLO_METRICS_QUERY_NAME,
	type PackedColoMetricState,
	PackedColoMetricStateSchema,
} from "./packed-colo-state";
import type { ResolvedConfig } from "./runtime-config";
import {
	CounterStateSchema,
	MetricExporterIdSchema,
	type MetricExporterIdString,
	type ScopeType,
	type TimeRange,
	type Zone,
} from "./types";

/**
 * Maximum allowed hostnames in HOST_METRICS_ALLOWLIST.
 * Limits GraphQL variable size and prevents cardinality explosion.
 */
const MAX_HOSTNAME_ALLOWLIST_SIZE = 50;

/**
 * Cloudflare GraphQL API limits queries to 10 zones (zonesHardLimit).
 * Zones are chunked and results merged to support accounts with >10 zones.
 */
const ZONES_PER_CHUNK = 10;

const MetricQueryStateSchema = z.object({
	// Metric storage
	counters: z.record(z.string(), CounterStateSchema),
	metrics: z.array(MetricDefinitionSchema),
	lastIngest: z.number(),

	// Refresh state
	lastRefresh: z.number(),
	nextRefresh: z.number(),
	lastError: z.string().nullable(),
	zoneRetryAfter: z.record(z.string(), z.number()).default({}),

	// SSL cert cache (zone-scoped only)
	lastSslFetch: z.number(),
});

type MetricQueryState = z.infer<typeof MetricQueryStateSchema>;

type MetricFetchResult = {
	metrics: MetricDefinition[];
	partialErrors: unknown[];
	failedScopes: ReadonlySet<string>;
	zoneRetryAfter: Record<string, number>;
};

/**
 * Account context a query runs against, owned by AccountMetricCoordinator.
 * Zone-scoped queries look up their zone in `zones` by scope ID.
 */
export type MetricQueryContext = {
	accountId: string;
	accountName: string;
	zones: readonly Zone[];
	firewallRules: Record<string, string>;
};

function emptyResult(metrics: MetricDefinition[] = []): MetricFetchResult {
	return {
		metrics,
		partialErrors: [],
		failedScopes: new Set(),
		zoneRetryAfter: {},
	};
}

/**
 * Computes when a query should next refresh.
 * Regular refreshes align to interval boundaries so every query of an account
 * shares one time window; longer backoff delays count from now.
 *
 * @param config Resolved runtime configuration.
 * @param delaySeconds Delay before the next refresh.
 * @param now Current time in milliseconds.
 * @returns Next refresh timestamp in milliseconds.
 */
export function nextRefreshTime(
	config: ResolvedConfig,
	delaySeconds: number = config.metricRefreshIntervalSeconds,
	now: number = Date.now(),
): number {
	const intervalMs = config.metricRefreshIntervalSeconds * 1000;
	return delaySeconds === config.metricRefreshIntervalSeconds
		? Math.floor(now / intervalMs) * intervalMs + intervalMs
		: now + delaySeconds * 1000;
}

/**
 * Fetches and caches Prometheus metrics for one query scope inside the
 * AccountMetricCoordinator Durable Object. Handles counter accumulation,
 * per-query refresh scheduling and backoff, and packed colo storage.
 *
 * Formerly a Durable Object of its own; running in-process avoids a
 * cross-object call per query on every refresh and scrape.
 */
export class MetricQuery {
	readonly id: MetricExporterIdString;
	readonly scopeType: ScopeType;
	readonly scopeId: string;
	readonly queryName: string;
	private readonly storage: ChunkedValueStorage;
	private readonly env: Env;
	private state: MetricQueryState | undefined;
	private loading: Promise<void> | undefined;

	/**
	 * @param id Composite ID in format "scopeType:scopeId:queryName".
	 * @param storage Storage of the owning Durable Object.
	 * @param env Worker environment bindings.
	 * @throws {ZodError} When ID format is invalid.
	 */
	constructor(
		id: MetricExporterIdString,
		storage: ChunkedValueStorage,
		env: Env,
	) {
		const parsed = MetricExporterIdSchema.parse(id);
		this.id = id;
		this.scopeType = parsed.scopeType;
		this.scopeId = parsed.scopeId;
		this.queryName = parsed.queryName;
		this.storage = storage;
		this.env = env;
	}

	private get stateKey(): string {
		return `query:${this.id}`;
	}

	private get packedColoKey(): string {
		return `query:${this.id}:packed-colo-metrics`;
	}

	private get isPackedColoQuery(): boolean {
		return (
			this.scopeType === "account" && this.queryName === COLO_METRICS_QUERY_NAME
		);
	}

	/**
	 * Create a logger instance with context from the query scope.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Logger instance with scope type, scope ID, and query name context.
	 */
	createLogger(config: ResolvedConfig): Logger {
		return createLogger("metric_exporter", {
			format: config.logFormat,
			level: config.logLevel,
		})
			.child(this.scopeType)
			.child(this.scopeId)
			.child(this.queryName);
	}

	/**
	 * Load persisted state, or start empty when none exists.
	 * A storage failure propagates and leaves the query unloaded, so a later call
	 * retries the load instead of overwriting state that is still on disk.
	 */
	load(): Promise<void> {
		if (this.state !== undefined) return Promise.resolve();
		// Share one read between concurrent callers so a slow read cannot replace
		// state that a refresh already updated.
		this.loading ??= this.readState().finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}

	private async readState(): Promise<void> {
		const stored = await loadChunkedValue(
			this.storage,
			this.stateKey,
			MetricQueryStateSchema,
		);
		this.state ??= stored ?? {
			counters: {},
			metrics: [],
			lastIngest: 0,
			lastRefresh: 0,
			nextRefresh: 0,
			lastError: null,
			zoneRetryAfter: {},
			lastSslFetch: 0,
		};
	}

	/**
	 * Get the current state or throw if not loaded.
	 *
	 * @returns Current state.
	 * @throws {Error} When load() has not completed.
	 */
	private getState(): MetricQueryState {
		if (this.state === undefined) {
			throw new Error("State not loaded - load() must be called first");
		}
		return this.state;
	}

	/** Next refresh time in milliseconds, or undefined until loaded. */
	get nextRefresh(): number | undefined {
		return this.state?.nextRefresh;
	}

	/**
	 * Whether the query's next refresh time has passed.
	 *
	 * @param now Current time in milliseconds.
	 */
	isDue(now: number = Date.now()): boolean {
		return this.getState().nextRefresh <= now;
	}

	/**
	 * Refresh metrics from Cloudflare API using the provided time range.
	 * Handles account-scoped and zone-scoped queries, processes counters, and
	 * schedules the next refresh.
	 *
	 * @param context Account and zone context from the coordinator.
	 * @param timeRange Time range for metrics queries.
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance for logging.
	 */
	async refresh(
		context: MetricQueryContext,
		timeRange: TimeRange,
		config: ResolvedConfig,
		logger: Logger,
	): Promise<void> {
		const state = this.getState();

		// Skip if zone context not yet available (account-scoped needs zones)
		if (this.scopeType === "account" && context.zones.length === 0) {
			logger.info("Skipping refresh - no zone context yet");
			await this.scheduleNextRefresh(config);
			return;
		}

		// Skip if zone metadata not available (zone-scoped)
		const zoneMetadata =
			this.scopeType === "zone"
				? context.zones.find((zone) => zone.id === this.scopeId)
				: undefined;
		if (this.scopeType === "zone" && zoneMetadata === undefined) {
			logger.info("Skipping refresh - no zone metadata yet");
			await this.scheduleNextRefresh(config);
			return;
		}

		// For zone-scoped (SSL certs), check cache TTL
		if (this.scopeType === "zone") {
			const cacheAgeMs = Date.now() - state.lastSslFetch;
			const cacheTtlMs = config.sslCertsCacheTtlSeconds * 1000;
			if (state.lastSslFetch > 0 && cacheAgeMs < cacheTtlMs) {
				logger.debug("SSL cert cache fresh, skipping fetch", {
					age_seconds: Math.floor(cacheAgeMs / 1000),
					ttl_seconds: config.sslCertsCacheTtlSeconds,
				});
				await this.scheduleNextRefresh(config);
				return;
			}
		}

		const client = getCloudflareMetricsClient(this.env);
		let nextRefreshDelaySeconds = config.metricRefreshIntervalSeconds;

		try {
			let result: MetricFetchResult;

			if (this.scopeType === "account") {
				result = await this.fetchAccountScopedMetrics(
					client,
					state,
					context,
					timeRange,
					config,
					logger,
				);
			} else {
				result = emptyResult(
					zoneMetadata === undefined
						? []
						: await this.fetchZoneScopedMetrics(client, zoneMetadata),
				);
			}

			const ingestId = new Date(timeRange.maxtime).getTime();
			if (config.coloMetricsPackedStorage && this.isPackedColoQuery) {
				// Packed colo counters live outside the generic MetricDefinition[] state.
				await this.savePackedColoMetricState(
					result.metrics,
					context,
					ingestId,
					result.failedScopes,
				);
				await this.saveState({
					...this.getState(),
					metrics: [],
					counters: {},
					lastIngest: ingestId,
					lastRefresh: Date.now(),
					nextRefresh: nextRefreshTime(config),
					lastError: null,
					zoneRetryAfter: result.zoneRetryAfter,
				});

				logger.info("Refresh complete", {
					metric_count: result.metrics.length,
					partial_failure_count: result.partialErrors.length,
				});
				return;
			}

			if (this.isPackedColoQuery) {
				// Packed storage is off: drop any packed snapshot so re-enabling the
				// flag starts a fresh counter generation instead of reviving old totals.
				await deleteChunkedValue(this.storage, this.packedColoKey);
			}
			const processed = accumulateCounterMetrics(
				result.metrics,
				state.counters,
				{
					ingestId,
					ageMissingCounters: state.lastIngest !== ingestId,
					failedScopes: result.failedScopes,
				},
			);
			const currentState = this.getState();
			await this.saveState({
				...currentState,
				metrics: processed.metrics,
				counters: processed.counters,
				lastIngest: ingestId,
				lastRefresh: Date.now(),
				nextRefresh: nextRefreshTime(config),
				lastSslFetch:
					this.scopeType === "zone" ? Date.now() : currentState.lastSslFetch,
				lastError: null,
				zoneRetryAfter: result.zoneRetryAfter,
			});

			logger.info("Refresh complete", {
				metric_count: result.metrics.length,
				partial_failure_count: result.partialErrors.length,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			nextRefreshDelaySeconds = getMetricRefreshDelaySeconds(
				error,
				config.metricRefreshIntervalSeconds,
			);
			logger.error("Refresh failed", {
				error: msg,
				retry_seconds: nextRefreshDelaySeconds,
			});
			await this.saveState({
				...this.getState(),
				nextRefresh: nextRefreshTime(config, nextRefreshDelaySeconds),
				lastError: msg,
			});
		}
	}

	/**
	 * Persist the next refresh time without touching metrics.
	 *
	 * @param config Resolved runtime configuration.
	 */
	private async scheduleNextRefresh(config: ResolvedConfig): Promise<void> {
		await this.saveState({
			...this.getState(),
			nextRefresh: nextRefreshTime(config),
		});
	}

	/**
	 * Fetch account-scoped metrics from Cloudflare API.
	 * Handles both account-level and zone-batched queries.
	 *
	 * @param client Cloudflare metrics client.
	 * @param state Current query state.
	 * @param context Account and zone context.
	 * @param timeRange Time range for metrics queries.
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 * @returns Array of metric definitions.
	 */
	private async fetchAccountScopedMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricQueryState,
		context: MetricQueryContext,
		timeRange: TimeRange,
		config: ResolvedConfig,
		logger: Logger,
	): Promise<MetricFetchResult> {
		const { queryName } = this;
		const { accountId, accountName, zones, firewallRules } = context;

		// Account-level queries (worker-totals, logpush-account, magic-transit)
		if (isAccountLevelQuery(queryName)) {
			return emptyResult(
				await client.getAccountMetrics(
					queryName,
					accountId,
					accountName,
					timeRange,
				),
			);
		}

		// Zone-batched queries - fetch all zones in one GraphQL call
		if (isZoneLevelQuery(queryName)) {
			// Hostname metrics guardrails: parse allowlist once for both guard + query
			let hostMetricsAllowlist: ReadonlySet<string> | undefined;
			let hostMetricsDelaySeconds: number | undefined;
			if (queryName === "hostname-http-metrics") {
				const parsed = parseCommaSeparated(config.hostMetricsAllowlist);
				// Normalize to lowercase per spec
				const normalized = new Set([...parsed].map((h) => h.toLowerCase()));
				if (normalized.size === 0) {
					logger.debug("Hostname metrics disabled: empty allowlist");
					return emptyResult();
				}
				if (normalized.size > MAX_HOSTNAME_ALLOWLIST_SIZE) {
					logger.error("Hostname allowlist exceeds maximum size", {
						size: normalized.size,
						max: MAX_HOSTNAME_ALLOWLIST_SIZE,
					});
					return emptyResult();
				}
				// excludeHost strips host labels from all metrics in prometheus.ts,
				// which would collapse distinct hostnames into duplicate gauge series
				// (max-dedup keeps only the highest value, losing per-host granularity).
				if (config.excludeHost) {
					logger.warn(
						"Hostname metrics disabled: excludeHost=true strips host labels",
					);
					return emptyResult();
				}
				hostMetricsAllowlist = normalized;
				hostMetricsDelaySeconds = config.hostMetricsDelaySeconds;
			}

			// Filter out free tier zones for paid-tier GraphQL queries
			let zonesToQuery = [...zones];
			if (isPaidTierGraphQLQuery(queryName)) {
				const { paid, free } = partitionZonesByTier(zonesToQuery);

				if (free.length > 0) {
					logger.info("Skipping free tier zones for paid-tier query", {
						skipped_zones: free.map((z) => z.name),
						processing_zones: paid.length,
					});
				}

				zonesToQuery = paid;

				if (zonesToQuery.length === 0) {
					logger.info("No paid tier zones to query");
					return emptyResult();
				}
			}

			if (zonesToQuery.length <= ZONES_PER_CHUNK) {
				const zoneIds = zonesToQuery.map((z) => z.id);
				return emptyResult(
					await client.getZoneMetrics(
						queryName,
						zoneIds,
						zonesToQuery,
						firewallRules,
						timeRange,
						hostMetricsAllowlist,
						hostMetricsDelaySeconds,
						config.httpStatusGroup,
						config.coloMetricsPackedStorage,
					),
				);
			}

			const chunkResults: MetricDefinition[][] = [];
			const partialErrors: unknown[] = [];
			const failedScopes = new Set<string>();
			const currentZoneIds = new Set(zonesToQuery.map((zone) => zone.id));
			const now = Date.now();
			const zoneRetryAfter: Record<string, number> = {};
			for (const [zoneId, retryAfter] of Object.entries(state.zoneRetryAfter)) {
				if (currentZoneIds.has(zoneId) && retryAfter > now) {
					zoneRetryAfter[zoneId] = retryAfter;
				}
			}
			const queryableZones = zonesToQuery.filter((zone) => {
				const retryAfter = zoneRetryAfter[zone.id] ?? 0;
				if (retryAfter <= now) return true;
				failedScopes.add(zone.name);
				logger.debug("Skipping zone during product-access backoff", {
					query: queryName,
					zone: zone.name,
					retry_after: new Date(retryAfter).toISOString(),
				});
				return false;
			});
			let firstChunkError: unknown;
			let longestRetryError: unknown;
			let longestRetrySeconds = config.metricRefreshIntervalSeconds;
			for (let i = 0; i < queryableZones.length; i += ZONES_PER_CHUNK) {
				const chunkZones = queryableZones.slice(i, i + ZONES_PER_CHUNK);
				const chunkIds = chunkZones.map((z) => z.id);

				try {
					const metrics = await client.getZoneMetrics(
						queryName,
						chunkIds,
						chunkZones,
						firewallRules,
						timeRange,
						hostMetricsAllowlist,
						hostMetricsDelaySeconds,
						config.httpStatusGroup,
						config.coloMetricsPackedStorage,
					);
					for (const zoneId of chunkIds) delete zoneRetryAfter[zoneId];
					chunkResults.push(metrics);
				} catch (error) {
					firstChunkError ??= error;
					partialErrors.push(error);
					for (const zone of chunkZones) failedScopes.add(zone.name);
					const retrySeconds = getMetricRefreshDelaySeconds(
						error,
						config.metricRefreshIntervalSeconds,
					);
					if (retrySeconds > longestRetrySeconds) {
						longestRetrySeconds = retrySeconds;
						longestRetryError = error;
					}
					if (retrySeconds > config.metricRefreshIntervalSeconds) {
						for (const zoneId of chunkIds) {
							zoneRetryAfter[zoneId] = now + retrySeconds * 1000;
						}
					}
					// Log and continue — partial results from other chunks are still valuable.
					logger.error("Zone chunk query failed", {
						query: queryName,
						chunk_index: Math.floor(i / ZONES_PER_CHUNK),
						chunk_size: chunkZones.length,
						total_zones: zonesToQuery.length,
						failed_zones: chunkZones.map((z) => z.name),
						error: error instanceof Error ? error.message : String(error),
						retry_seconds: retrySeconds,
					});
				}
			}

			if (chunkResults.length === 0 && firstChunkError !== undefined) {
				throw longestRetryError ?? firstChunkError;
			}
			return {
				metrics: mergeMetricDefinitions(...chunkResults),
				partialErrors,
				failedScopes,
				zoneRetryAfter,
			};
		}

		// Unknown query - should not happen if IDs are constructed correctly
		console.error("Unknown query type", { queryName });
		return emptyResult();
	}

	/**
	 * Fetch zone-scoped metrics from Cloudflare API.
	 * Handles SSL certificates and load balancer weight metrics.
	 *
	 * @param client Cloudflare metrics client.
	 * @param zone Zone metadata for this query's scope.
	 * @returns Array of metric definitions.
	 */
	private async fetchZoneScopedMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		zone: Zone,
	): Promise<MetricDefinition[]> {
		switch (this.queryName) {
			case "ssl-certificates":
				return client.getSSLCertificateMetricsForZone(zone);
			case "lb-weight-metrics":
				return client.getLbWeightMetricsForZone(zone);
			default:
				console.error("Unknown zone-scoped query", {
					queryName: this.queryName,
				});
				return [];
		}
	}

	private async loadPackedColoMetricState(): Promise<
		PackedColoMetricState | undefined
	> {
		return loadChunkedValue(
			this.storage,
			this.packedColoKey,
			PackedColoMetricStateSchema,
		);
	}

	private async savePackedColoMetricState(
		metrics: MetricDefinition[],
		context: MetricQueryContext,
		ingestId: number,
		failedScopes: ReadonlySet<string>,
	): Promise<void> {
		const previous = await this.loadPackedColoMetricState();
		await saveChunkedValue(this.storage, this.packedColoKey, {
			format: "colo-packed-by-zone-v2",
			accountId: context.accountId,
			accountName: context.accountName,
			queryName: COLO_METRICS_QUERY_NAME,
			lastFetch: Date.now(),
			lastIngest: ingestId,
			zones: accumulatePackedColoRows(
				previous,
				metrics,
				ingestId,
				failedScopes,
			),
		} satisfies PackedColoMetricState);
	}

	/** Persist state in bounded storage chunks before publishing it in memory. */
	private async saveState(state: MetricQueryState): Promise<void> {
		await saveChunkedValue(this.storage, this.stateKey, state);
		this.state = state;
	}

	/**
	 * Return cached accumulated metrics.
	 *
	 * @returns Current snapshot of metrics with accumulated counter values.
	 */
	export(): MetricDefinition[] {
		return this.getState().metrics;
	}

	/** Packed colo counters, or undefined until the first packed refresh has run. */
	async exportPackedColoMetrics(): Promise<PackedColoMetricState | undefined> {
		if (!this.isPackedColoQuery) {
			return undefined;
		}
		return this.loadPackedColoMetricState();
	}
}
