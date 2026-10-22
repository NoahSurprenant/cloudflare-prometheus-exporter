import { DurableObject } from "cloudflare:workers";

/**
 * Retired Durable Object that used to run one metric query per instance.
 *
 * Metric queries now run in-process inside AccountMetricCoordinator (see
 * `lib/metric-query.ts`), because every cross-object call leaks native memory
 * under `wrangler dev --local` (cloudflare/workerd#6894). The class stays
 * exported because removing it requires a `deleted_classes` migration.
 * Instances left behind by earlier versions clear their storage the next time
 * their refresh alarm fires, so they stop polling the Cloudflare API.
 */
export class MetricExporter extends DurableObject<Env> {
	override async alarm(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}
}
