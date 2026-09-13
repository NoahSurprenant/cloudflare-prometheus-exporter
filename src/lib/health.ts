import {
	CLOUDFLARE_GQL_URL,
	getCloudflareMetricsClient,
} from "../cloudflare/client";
import { extractErrorInfo, withTimeout } from "./errors";
import { getConfig } from "./runtime-config";

const CHECK_TIMEOUT_MS = 5_000;

type CheckStatus = "healthy" | "unhealthy";

type HealthCheck = {
	status: CheckStatus;
	latency_ms: number;
	error?: string;
	error_code?: string;
};

type HealthResponse = {
	status: CheckStatus;
	timestamp: string;
	checks: {
		cloudflare_api: HealthCheck;
		graphql_api: HealthCheck;
	};
};

type CachedHealth = {
	response: HealthResponse;
	expires: number;
};

let healthCache: CachedHealth | null = null;

/**
 * Check Cloudflare REST API connectivity by fetching accounts.
 *
 * @param env Environment variables.
 * @returns Health check result.
 */
async function checkCloudflareApi(env: Env): Promise<HealthCheck> {
	const start = performance.now();

	try {
		const client = getCloudflareMetricsClient(env);
		const result = await withTimeout(
			client.getAccounts(),
			CHECK_TIMEOUT_MS,
			"Cloudflare API health check",
		);
		const latency_ms = Math.round(performance.now() - start);

		if (result.ok) {
			return { status: "healthy", latency_ms };
		}
		return {
			status: "unhealthy",
			latency_ms,
			error: result.error.message,
			error_code: result.error.code,
		};
	} catch (err) {
		const latency_ms = Math.round(performance.now() - start);
		const info = extractErrorInfo(err);
		return {
			status: "unhealthy",
			latency_ms,
			error: info.message,
			error_code: info.code,
		};
	}
}

/**
 * Check Cloudflare GraphQL API connectivity via introspection.
 *
 * @param env Environment variables.
 * @returns Health check result.
 */
async function checkGraphqlApi(env: Env): Promise<HealthCheck> {
	const start = performance.now();

	try {
		const result = await withTimeout(
			fetch(CLOUDFLARE_GQL_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				},
				body: JSON.stringify({
					query: "{ __typename }",
				}),
			}),
			CHECK_TIMEOUT_MS,
			"GraphQL API health check",
		);

		const latency_ms = Math.round(performance.now() - start);

		if (!result.ok) {
			return {
				status: "unhealthy",
				latency_ms,
				error: result.error.message,
				error_code: result.error.code,
			};
		}

		const response = result.value;
		if (!response.ok) {
			return {
				status: "unhealthy",
				latency_ms,
				error: `HTTP ${response.status}`,
				error_code: "API_UNAVAILABLE",
			};
		}

		return { status: "healthy", latency_ms };
	} catch (err) {
		const latency_ms = Math.round(performance.now() - start);
		const info = extractErrorInfo(err);
		return {
			status: "unhealthy",
			latency_ms,
			error: info.message,
			error_code: info.code,
		};
	}
}

/**
 * Perform health check with configurable caching.
 *
 * @param env Environment variables.
 * @returns Health check response.
 */
export async function checkHealth(env: Env): Promise<HealthResponse> {
	const now = Date.now();
	const config = await getConfig(env);
	const cacheTtlMs = config.healthCheckCacheTtlSeconds * 1000;

	if (healthCache && healthCache.expires > now) {
		return healthCache.response;
	}

	const [cloudflareApi, graphqlApi] = await Promise.all([
		checkCloudflareApi(env),
		checkGraphqlApi(env),
	]);

	const allHealthy =
		cloudflareApi.status === "healthy" && graphqlApi.status === "healthy";

	const response: HealthResponse = {
		status: allHealthy ? "healthy" : "unhealthy",
		timestamp: new Date().toISOString(),
		checks: {
			cloudflare_api: cloudflareApi,
			graphql_api: graphqlApi,
		},
	};

	healthCache = {
		response,
		expires: now + cacheTtlMs,
	};

	return response;
}

/**
 * Build HTTP response from health check result.
 *
 * @param health Health check response.
 * @returns HTTP response with JSON body.
 */
export function healthResponse(health: HealthResponse): Response {
	const status = health.status === "healthy" ? 200 : 503;
	return new Response(JSON.stringify(health), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
