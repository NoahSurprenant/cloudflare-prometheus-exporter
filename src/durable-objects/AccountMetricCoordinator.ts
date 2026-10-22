import { DurableObject } from "cloudflare:workers";
import {
	ACCOUNT_LEVEL_QUERIES,
	getCloudflareMetricsClient,
	ZONE_LEVEL_QUERIES,
} from "../cloudflare/client";
import { FREE_TIER_QUERIES } from "../cloudflare/queries";
import { runAlarmWithRecovery } from "../lib/alarm-recovery";
import { chunkedDurableObjectStorage } from "../lib/chunked-storage";
import {
	filterZonesByIds,
	isFreeTierZone,
	parseCommaSeparated,
} from "../lib/filters";
import { createLogger, type Logger } from "../lib/logger";
import {
	MetricQuery,
	type MetricQueryContext,
	nextRefreshTime,
} from "../lib/metric-query";
import type { MetricDefinition } from "../lib/metrics";
import {
	COLO_METRICS_QUERY_NAME,
	type PackedColoMetricState,
} from "../lib/packed-colo-state";
import { getConfig, type ResolvedConfig } from "../lib/runtime-config";
import { getTimeRange } from "../lib/time";
import type { MetricExporterIdString, Zone } from "../lib/types";

const STATE_KEY = "state";
const ALARM_RECOVERY_DELAY_MS = 60 * 1000;
/**
 * How many refresh intervals the alarm may be overdue before a scrape treats
 * it as lost and repairs it.
 */
const LOST_ALARM_GRACE_INTERVALS = 2;

// Account-scoped queries: all account-level + zone-batched (excludes zone-scoped REST queries)
const ACCOUNT_SCOPED_QUERIES = [
	...ACCOUNT_LEVEL_QUERIES,
	...ZONE_LEVEL_QUERIES.filter(
		(q) => q !== "ssl-certificates" && q !== "lb-weight-metrics",
	),
] as const;

/**
 * Filters account-scoped queries based on account tier and config.
 * Hostname metrics are excluded when the allowlist is empty or excludeHost is true
 * to avoid refreshing a query that would do nothing every cycle.
 */
function getActiveAccountQueries(
	config: ResolvedConfig,
	isFreeTierAccount: boolean,
): readonly string[] {
	const hostnameEnabled =
		parseCommaSeparated(config.hostMetricsAllowlist).size > 0 &&
		!config.excludeHost;

	return ACCOUNT_SCOPED_QUERIES.filter((q) => {
		if (
			isFreeTierAccount &&
			!FREE_TIER_QUERIES.includes(q as (typeof FREE_TIER_QUERIES)[number])
		) {
			return false;
		}
		if (q === "hostname-http-metrics" && !hostnameEnabled) {
			return false;
		}
		return true;
	});
}

// Zone-scoped REST queries (one query per zone for fault isolation)
const ZONE_SCOPED_QUERIES = ["ssl-certificates", "lb-weight-metrics"] as const;

type AccountMetricCoordinatorState = {
	accountId: string;
	accountName: string;
	zones: Zone[];
	totalZoneCount: number;
	firewallRules: Record<string, string>;
	lastZoneFetch: number;
	lastRefresh: number;
};

/**
 * Collects metrics for a Cloudflare account: caches the zone list and runs every
 * metric query in-process on its own alarm, keeping results in its storage.
 */
export class AccountMetricCoordinator extends DurableObject<Env> {
	private state: AccountMetricCoordinatorState | undefined;
	/** Metric queries by ID, created on first use and loaded lazily from storage. */
	private readonly queries = new Map<MetricExporterIdString, MetricQuery>();
	/** The refresh currently running, so overlapping callers share it instead of fetching twice. */
	private refreshInFlight: Promise<void> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.state =
				await ctx.storage.get<AccountMetricCoordinatorState>(STATE_KEY);
		});
	}

	/**
	 * Creates logger instance with account-specific tag.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Logger instance.
	 */
	private createLogger(config: ResolvedConfig): Logger {
		const state = this.getState();
		const tag = state.accountName.toLowerCase().replace(/[ -]/g, "_");
		return createLogger("account_coordinator", {
			format: config.logFormat,
			level: config.logLevel,
		}).child(tag);
	}

	/**
	 * Gets current coordinator state.
	 *
	 * @returns Current state.
	 * @throws {Error} When state not initialized.
	 */
	private getState(): AccountMetricCoordinatorState {
		if (this.state === undefined) {
			console.error(
				"[account_coordinator] State not initialized - exportForPrometheus() must be called first",
			);
			throw new Error("State not initialized");
		}
		return this.state;
	}

	/**
	 * Gets coordinator stub for account. The coordinator initializes itself on
	 * its first export, so no setup call is made here.
	 *
	 * @param accountId Cloudflare account ID.
	 * @param env Worker environment bindings.
	 * @returns Coordinator stub.
	 */
	static get(accountId: string, env: Env) {
		return env.AccountMetricCoordinator.getByName(`account:${accountId}`);
	}

	/**
	 * Initializes coordinator state on first use. No-op once initialized.
	 *
	 * @param accountId Cloudflare account ID.
	 * @param accountName Account display name for logging.
	 */
	private async ensureInitialized(
		accountId: string,
		accountName: string,
	): Promise<void> {
		if (this.state !== undefined) {
			return;
		}

		this.state = {
			accountId,
			accountName,
			zones: [],
			totalZoneCount: 0,
			firewallRules: {},
			lastZoneFetch: 0,
			lastRefresh: 0,
		};
		await this.ctx.storage.put(STATE_KEY, this.state);
	}

	override async alarm(): Promise<void> {
		if (this.state === undefined) {
			// Nothing to refresh until the first export supplies the account.
			return;
		}
		let logger: Logger | undefined;

		await runAlarmWithRecovery({
			run: async () => {
				const config = await getConfig(this.env);
				logger = this.createLogger(config);
				logger.info("Alarm fired, refreshing");
				await this.refreshOnce(config, logger);
			},
			getLogger: () => logger,
			scheduleRecoveryAlarm: () =>
				this.ctx.storage.setAlarm(Date.now() + ALARM_RECOVERY_DELAY_MS),
		});
	}

	/**
	 * Run a refresh, or join the one already running.
	 *
	 * Durable Objects interleave calls while a request awaits the network, so the
	 * alarm and a scrape could otherwise fetch the same data at the same time.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 */
	private refreshOnce(config: ResolvedConfig, logger: Logger): Promise<void> {
		if (this.refreshInFlight !== undefined) {
			logger.debug("Refresh already running, joining it");
			return this.refreshInFlight;
		}
		const refresh = this.refresh(config, logger).finally(() => {
			if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
		});
		this.refreshInFlight = refresh;
		return refresh;
	}

	/**
	 * Refreshes the zone list if stale, runs every metric query that is due, and
	 * schedules the next alarm.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 */
	private async refresh(config: ResolvedConfig, logger: Logger): Promise<void> {
		logger.info("Starting refresh");

		try {
			await this.refreshZones(config, logger);
			await this.refreshQueries(config, logger);

			this.state = { ...this.getState(), lastRefresh: Date.now() };
			await this.ctx.storage.put(STATE_KEY, this.state);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("Refresh failed", { error: msg });
		}

		await this.scheduleNextAlarm(config);
	}

	/**
	 * Schedule the alarm for the next refresh interval boundary, or earlier when
	 * a query is due before it, with jitter.
	 *
	 * @param config Resolved runtime configuration.
	 */
	private async scheduleNextAlarm(config: ResolvedConfig): Promise<void> {
		const now = Date.now();
		let next = nextRefreshTime(config, undefined, now);
		for (const query of this.queries.values()) {
			const queryNext = query.nextRefresh;
			// Queries still due after a refresh failed hard; wait for the boundary.
			if (queryNext !== undefined && queryNext > now && queryNext < next) {
				next = queryNext;
			}
		}
		const jitter = 1000 + Math.random() * 4000;
		await this.ctx.storage.setAlarm(next + jitter);
	}

	/**
	 * Restart the refresh cycle if its alarm has been lost.
	 *
	 * The cycle lives entirely in this object's alarm: each refresh schedules the
	 * next one. If an alarm is dropped (seen under `wrangler dev --local`, where
	 * alarms persisted in storage did not fire again after a restart), nothing
	 * else refreshes the account. Scrapes run this check and repair a missing or
	 * long-overdue alarm.
	 *
	 * It cannot stampede the API: it does nothing while the alarm is healthy or
	 * a refresh is running, only reschedules when the last successful refresh is
	 * under one interval old, and goes through the same refresh path as the
	 * alarm (per-query schedules, SSL cache TTL, backoff delays, rate limiter).
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 */
	private async recoverLostAlarm(
		config: ResolvedConfig,
		logger: Logger,
	): Promise<void> {
		// A running refresh schedules the next alarm when it finishes; while an
		// alarm handler runs, getAlarm() reports no alarm.
		if (this.refreshInFlight !== undefined) {
			return;
		}
		const alarm = await this.ctx.storage.getAlarm();
		const intervalMs = config.metricRefreshIntervalSeconds * 1000;
		const now = Date.now();
		if (
			alarm !== null &&
			alarm >= now - LOST_ALARM_GRACE_INTERVALS * intervalMs
		) {
			return;
		}

		const state = this.getState();
		const context = {
			alarm: alarm === null ? null : new Date(alarm).toISOString(),
			last_refresh:
				state.lastRefresh > 0
					? new Date(state.lastRefresh).toISOString()
					: null,
		};
		if (now - state.lastRefresh < intervalMs) {
			logger.warn("Refresh alarm lost, rescheduling", context);
			await this.scheduleNextAlarm(config);
			return;
		}

		logger.warn("Refresh alarm lost, refreshing now", context);
		await this.refreshOnce(config, logger);
	}

	/**
	 * Refreshes zone list and firewall rules if the cache is stale.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 */
	private async refreshZones(
		config: ResolvedConfig,
		logger: Logger,
	): Promise<void> {
		const state = this.getState();
		const ttlMs = config.zoneListCacheTtlSeconds * 1000;
		const isStale = Date.now() - state.lastZoneFetch >= ttlMs;

		if (!isStale && state.zones.length > 0) {
			return;
		}

		const client = getCloudflareMetricsClient(this.env);
		logger.info("Refreshing zones");

		const allZones = await client.getZones(state.accountId);

		// Apply zone whitelist if set
		const cfZonesSet =
			config.cfZones !== null ? parseCommaSeparated(config.cfZones) : null;
		const zones =
			cfZonesSet !== null ? filterZonesByIds(allZones, cfZonesSet) : allZones;

		// Build firewall rules map
		const firewallRules: Record<string, string> = {};
		const rulesResults = await Promise.all(
			zones.map((zone) =>
				client.getFirewallRules(zone.id).catch((error) => {
					const msg = error instanceof Error ? error.message : String(error);
					logger.warn("Failed to fetch firewall rules", {
						zone: zone.name,
						error: msg,
					});
					return new Map<string, string>();
				}),
			),
		);
		for (const rules of rulesResults) {
			for (const [id, name] of rules) {
				firewallRules[id] = name;
			}
		}

		this.state = {
			...state,
			zones,
			totalZoneCount: allZones.length,
			firewallRules,
			lastZoneFetch: Date.now(),
		};
		await this.ctx.storage.put(STATE_KEY, this.state);

		logger.info("Zones cached", {
			total: allZones.length,
			filtered: zones.length,
		});
	}

	/**
	 * Returns the metric queries active for this account, in export order:
	 * account-scoped queries, then zone-scoped queries per zone (skipped for free
	 * tier accounts). Queries no longer active are dropped from memory.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Active metric queries.
	 */
	private getActiveQueries(config: ResolvedConfig): MetricQuery[] {
		const state = this.getState();

		// Check if this account is marked as free tier
		const cfFreeTierSet = parseCommaSeparated(config.cfFreeTierAccounts);
		const isFreeTierAccount = cfFreeTierSet.has(state.accountId);

		const ids: MetricExporterIdString[] = [
			...getActiveAccountQueries(config, isFreeTierAccount).map(
				(query): MetricExporterIdString =>
					`account:${state.accountId}:${query}`,
			),
			...(isFreeTierAccount
				? []
				: state.zones.flatMap((zone) =>
						ZONE_SCOPED_QUERIES.map(
							(query): MetricExporterIdString => `zone:${zone.id}:${query}`,
						),
					)),
		];

		const active = new Set(ids);
		for (const id of this.queries.keys()) {
			if (!active.has(id)) this.queries.delete(id);
		}

		return ids.map((id) => {
			let query = this.queries.get(id);
			if (query === undefined) {
				query = new MetricQuery(
					id,
					chunkedDurableObjectStorage(this.ctx.storage),
					this.env,
				);
				this.queries.set(id, query);
			}
			return query;
		});
	}

	/**
	 * Runs every active query whose refresh time has passed, all against one
	 * shared time range. Failures are isolated per query.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 */
	private async refreshQueries(
		config: ResolvedConfig,
		logger: Logger,
	): Promise<void> {
		const state = this.getState();
		// Calculate shared time range once for all queries in this refresh cycle
		const timeRange = getTimeRange(
			config.scrapeDelaySeconds,
			config.timeWindowSeconds,
		);
		const context: MetricQueryContext = {
			accountId: state.accountId,
			accountName: state.accountName,
			zones: state.zones,
			firewallRules: state.firewallRules,
		};
		const queries = this.getActiveQueries(config);
		const now = Date.now();
		let refreshed = 0;

		await Promise.all(
			queries.map(async (query) => {
				try {
					await query.load();
					if (!query.isDue(now)) return;
					refreshed++;
					await query.refresh(
						context,
						timeRange,
						config,
						query.createLogger(config),
					);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					logger.error("Failed to refresh query", {
						query: query.id,
						error: msg,
					});
				}
			}),
		);

		logger.info("Queries refreshed", {
			account_scoped: queries.filter((q) => q.scopeType === "account").length,
			zone_scoped: queries.filter((q) => q.scopeType === "zone").length,
			refreshed,
		});
	}

	/**
	 * Returns normal MetricDefinition[] data plus packed colo data separately.
	 * The caller decides the colo storage mode for the whole scrape; with packed
	 * storage, colo-metrics are read only from packed state.
	 *
	 * @param options Account identity (initializes the coordinator on first call) and colo storage mode.
	 */
	async exportForPrometheus(options: {
		accountId: string;
		accountName: string;
		packedColoStorage: boolean;
	}): Promise<{
		metrics: MetricDefinition[];
		packedColoMetrics: PackedColoMetricState[];
		zoneCounts: {
			total: number;
			filtered: number;
			processed: number;
			skippedFreeTier: number;
		};
	}> {
		await this.ensureInitialized(options.accountId, options.accountName);
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);

		logger.info("Exporting metrics");

		// Ensure queries have been refreshed recently
		const staleThreshold = config.metricRefreshIntervalSeconds * 2 * 1000;
		const initialState = this.getState();
		if (
			initialState.lastRefresh === 0 ||
			Date.now() - initialState.lastRefresh > staleThreshold
		) {
			await this.refreshOnce(config, logger);
		} else {
			await this.recoverLostAlarm(config, logger);
		}

		// Re-get state after potential refresh (this.state may have been updated)
		const state = this.getState();
		const queries = this.getActiveQueries(config);
		const usePackedColoMetrics =
			options.packedColoStorage &&
			queries.some(
				(query) =>
					query.scopeType === "account" &&
					query.queryName === COLO_METRICS_QUERY_NAME,
			);

		const packedColoMetrics: PackedColoMetricState[] = [];
		const metricsResults = await Promise.all(
			queries.map(async (query): Promise<MetricDefinition[]> => {
				try {
					await query.load();
					if (
						usePackedColoMetrics &&
						query.scopeType === "account" &&
						query.queryName === COLO_METRICS_QUERY_NAME
					) {
						const packed = await query.exportPackedColoMetrics();
						if (packed !== undefined) packedColoMetrics.push(packed);
						return [];
					}
					return query.export();
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					if (query.scopeType === "account") {
						logger.error("Failed to export account metrics", {
							query: query.queryName,
							error: msg,
						});
					} else {
						logger.error("Failed to export zone metrics", {
							zone:
								state.zones.find((zone) => zone.id === query.scopeId)?.name ??
								query.scopeId,
							query: query.queryName,
							error: msg,
						});
					}
					return [];
				}
			}),
		);

		const allMetrics = metricsResults.flat();

		// Count unique zones with metrics from all results
		const zonesWithMetrics = new Set<string>();
		for (const metric of allMetrics) {
			for (const v of metric.values) {
				const zone = v.labels.zone;
				if (zone) {
					zonesWithMetrics.add(zone);
				}
			}
		}
		for (const packed of packedColoMetrics) {
			for (const zoneBucket of packed.zones) {
				if (zoneBucket.colo.length > 0) zonesWithMetrics.add(zoneBucket.zone);
			}
		}
		const processedZones = zonesWithMetrics.size;

		// Count free tier zones
		const freeTierCount = state.zones.filter(isFreeTierZone).length;

		return {
			metrics: allMetrics,
			packedColoMetrics,
			zoneCounts: {
				total: state.totalZoneCount,
				filtered: state.zones.length,
				processed: processedZones,
				skippedFreeTier: freeTierCount,
			},
		};
	}
}
