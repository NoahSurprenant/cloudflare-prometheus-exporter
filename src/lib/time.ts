import type { TimeRange } from "./types";

/**
 * Computes time range for GraphQL queries with delay and window.
 * Rounds to nearest minute and applies delay to account for ingestion lag.
 *
 * @param scrapeDelaySeconds Delay in seconds to account for ingestion lag.
 * @param timeWindowSeconds Window size in seconds for the time range.
 * @returns Time range with mintime and maxtime ISO strings.
 */
export function getTimeRange(
	scrapeDelaySeconds: number = 300,
	timeWindowSeconds: number = 60,
): TimeRange {
	const now = new Date();
	now.setSeconds(0, 0);
	now.setTime(now.getTime() - scrapeDelaySeconds * 1000);
	const maxtime = now.toISOString();
	now.setTime(now.getTime() - timeWindowSeconds * 1000);
	const mintime = now.toISOString();
	return { mintime, maxtime };
}

/**
 * Generates deterministic metric key from name and labels.
 * Labels are sorted alphabetically for consistency.
 *
 * @param name Metric name.
 * @param labels Label key value pairs.
 * @returns Formatted metric key string.
 */
export function metricKey(
	name: string,
	labels: Record<string, string>,
): string {
	const sortedLabels = Object.entries(labels)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join(",");
	return `${name}{${sortedLabels}}`;
}
