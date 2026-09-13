/**
 * Error codes for categorization and alerting.
 */
export const ErrorCode = {
	// API/Network
	API_RATE_LIMITED: "API_RATE_LIMITED",
	API_TIMEOUT: "API_TIMEOUT",
	API_UNAVAILABLE: "API_UNAVAILABLE",
	API_AUTH_FAILED: "API_AUTH_FAILED",

	// GraphQL
	GRAPHQL_ERROR: "GRAPHQL_ERROR",
	GRAPHQL_FIELD_ACCESS: "GRAPHQL_FIELD_ACCESS",

	// Config
	CONFIG_INVALID: "CONFIG_INVALID",
	CONFIG_PARSE_ERROR: "CONFIG_PARSE_ERROR",

	// State
	STATE_NOT_INITIALIZED: "STATE_NOT_INITIALIZED",

	// Validation
	VALIDATION_ERROR: "VALIDATION_ERROR",

	// Timeout
	TIMEOUT: "TIMEOUT",

	// Unknown
	UNKNOWN: "UNKNOWN",
} as const;

/**
 * Error code type.
 */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Error context type.
 */
type ErrorContext = Record<string, unknown>;

/**
 * CloudflarePrometheusError options.
 */
type CloudflarePrometheusErrorOptions = ErrorOptions & {
	context?: ErrorContext;
	retryable?: boolean;
};

/**
 * Base error class with cause chaining, error codes, and structured logging support.
 */
export class CloudflarePrometheusError extends Error {
	readonly code: ErrorCode;
	readonly context: ErrorContext;
	readonly timestamp: string;
	readonly retryable: boolean;

	/**
	 * Create a CloudflarePrometheusError.
	 *
	 * @param message Error message.
	 * @param code Error code.
	 * @param options Error options.
	 */
	constructor(
		message: string,
		code: ErrorCode,
		options?: CloudflarePrometheusErrorOptions,
	) {
		super(message, options);

		// Fix prototype chain for instanceof checks
		Object.setPrototypeOf(this, new.target.prototype);

		this.name = this.constructor.name;
		this.code = code;
		this.context = options?.context ?? {};
		this.timestamp = new Date().toISOString();
		this.retryable = options?.retryable ?? false;

		// Append cause stack if available
		if (options?.cause instanceof Error) {
			this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
		}
	}

	/**
	 * Convert to structured data for logging.
	 *
	 * @returns Structured error context.
	 */
	toStructuredData(): ErrorContext {
		return {
			error_code: this.code,
			error_message: this.message,
			error_name: this.name,
			error_retryable: this.retryable,
			...this.context,
		};
	}
}

/**
 * API errors (rate limits, unavailable, auth failures).
 */
export class ApiError extends CloudflarePrometheusError {
	readonly statusCode?: number;

	/**
	 * Create an ApiError.
	 *
	 * @param message Error message.
	 * @param options Error options.
	 */
	constructor(
		message: string,
		options?: CloudflarePrometheusErrorOptions & { statusCode?: number },
	) {
		const statusCode = options?.statusCode;
		let code: ErrorCode;
		let retryable = false;

		if (statusCode === 429) {
			code = ErrorCode.API_RATE_LIMITED;
			retryable = true;
		} else if (statusCode === 401 || statusCode === 403) {
			code = ErrorCode.API_AUTH_FAILED;
		} else if (statusCode !== undefined && statusCode >= 500) {
			code = ErrorCode.API_UNAVAILABLE;
			retryable = true;
		} else {
			code = ErrorCode.API_UNAVAILABLE;
		}

		super(message, code, { ...options, retryable });
		this.statusCode = statusCode;
	}

	/**
	 * Convert to structured data for logging.
	 *
	 * @returns Structured error context.
	 */
	override toStructuredData(): ErrorContext {
		return {
			...super.toStructuredData(),
			...(this.statusCode !== undefined && { status_code: this.statusCode }),
		};
	}
}

/**
 * GraphQL error detail.
 */
type GraphQLErrorDetail = {
	message: string;
	path?: ReadonlyArray<string | number>;
	extensions?: Record<string, unknown>;
};

/**
 * GraphQL query errors with access to underlying error details.
 */
export class GraphQLError extends CloudflarePrometheusError {
	readonly graphqlErrors: GraphQLErrorDetail[];

	/**
	 * Create a GraphQLError.
	 *
	 * @param message Error message.
	 * @param graphqlErrors GraphQL error details.
	 * @param options Error options.
	 */
	constructor(
		message: string,
		graphqlErrors: GraphQLErrorDetail[] = [],
		options?: CloudflarePrometheusErrorOptions,
	) {
		const hasFieldAccessError = graphqlErrors.some(
			(e) =>
				e.message.includes("does not have access") ||
				e.extensions?.code === "FORBIDDEN",
		);
		const code = hasFieldAccessError
			? ErrorCode.GRAPHQL_FIELD_ACCESS
			: ErrorCode.GRAPHQL_ERROR;

		super(message, code, options);
		this.graphqlErrors = graphqlErrors;
	}

	/**
	 * Convert to structured data for logging.
	 *
	 * @returns Structured error context.
	 */
	override toStructuredData(): ErrorContext {
		return {
			...super.toStructuredData(),
			graphql_error_count: this.graphqlErrors.length,
			graphql_paths: this.graphqlErrors
				.map((e) => e.path?.join("."))
				.filter(Boolean),
		};
	}
}

/**
 * Configuration parsing/validation errors.
 */
export class ConfigError extends CloudflarePrometheusError {
	readonly issues?: Array<{ path: string; message: string }>;

	/**
	 * Create a ConfigError.
	 *
	 * @param message Error message.
	 * @param options Error options.
	 */
	constructor(
		message: string,
		options?: CloudflarePrometheusErrorOptions & {
			issues?: Array<{ path: string; message: string }>;
		},
	) {
		const code = message.includes("parse")
			? ErrorCode.CONFIG_PARSE_ERROR
			: ErrorCode.CONFIG_INVALID;
		super(message, code, options);
		this.issues = options?.issues;
	}

	/**
	 * Convert to structured data for logging.
	 *
	 * @returns Structured error context.
	 */
	override toStructuredData(): ErrorContext {
		return {
			...super.toStructuredData(),
			...(this.issues && { validation_issues: this.issues }),
		};
	}
}

/**
 * State not initialized (DO not ready).
 */
export class StateNotInitializedError extends CloudflarePrometheusError {
	/**
	 * Create a StateNotInitializedError.
	 *
	 * @param component Component name.
	 * @param options Error options.
	 */
	constructor(
		component: string,
		options?: Omit<CloudflarePrometheusErrorOptions, "context">,
	) {
		super(
			`State not initialized - initialize() must be called first`,
			ErrorCode.STATE_NOT_INITIALIZED,
			{
				...options,
				context: { component },
			},
		);
	}
}

/**
 * Operation timeout.
 */
export class TimeoutError extends CloudflarePrometheusError {
	readonly timeoutMs: number;
	readonly operation: string;

	/**
	 * Create a TimeoutError.
	 *
	 * @param operation Operation name.
	 * @param timeoutMs Timeout in milliseconds.
	 * @param options Error options.
	 */
	constructor(
		operation: string,
		timeoutMs: number,
		options?: CloudflarePrometheusErrorOptions,
	) {
		super(`${operation} timed out after ${timeoutMs}ms`, ErrorCode.TIMEOUT, {
			...options,
			retryable: true,
			context: { ...options?.context, operation, timeout_ms: timeoutMs },
		});
		this.timeoutMs = timeoutMs;
		this.operation = operation;
	}
}

/**
 * Race promise against timeout with proper cleanup.
 *
 * @param promise Promise to race.
 * @param ms Timeout in milliseconds.
 * @param operation Operation name.
 * @returns Discriminated union for type-safe handling.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	operation = "Operation",
): Promise<{ ok: true; value: T } | { ok: false; error: TimeoutError }> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new TimeoutError(operation, ms)), ms);
	});

	try {
		const value = await Promise.race([promise, timeoutPromise]);
		return { ok: true, value };
	} catch (err) {
		if (err instanceof TimeoutError) {
			return { ok: false, error: err };
		}
		throw err;
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Validation error (Zod or other).
 */
export class ValidationError extends CloudflarePrometheusError {
	readonly field?: string;

	/**
	 * Create a ValidationError.
	 *
	 * @param message Error message.
	 * @param options Error options.
	 */
	constructor(
		message: string,
		options?: CloudflarePrometheusErrorOptions & { field?: string },
	) {
		super(message, ErrorCode.VALIDATION_ERROR, options);
		this.field = options?.field;
	}

	/**
	 * Convert to structured data for logging.
	 *
	 * @returns Structured error context.
	 */
	override toStructuredData(): ErrorContext {
		return {
			...super.toStructuredData(),
			...(this.field && { field: this.field }),
		};
	}
}

/**
 * Extract structured error info from any error type.
 *
 * @param error Error to extract info from.
 * @returns Structured error info.
 */
export function extractErrorInfo(error: unknown): {
	message: string;
	stack?: string;
	code: ErrorCode;
	context: ErrorContext;
	retryable: boolean;
} {
	if (error instanceof CloudflarePrometheusError) {
		return {
			message: error.message,
			stack: error.stack,
			code: error.code,
			context: error.context,
			retryable: error.retryable,
		};
	}

	if (error instanceof Error) {
		return {
			message: error.message,
			stack: error.stack,
			code: ErrorCode.UNKNOWN,
			context: {},
			retryable: false,
		};
	}

	return {
		message: String(error),
		code: ErrorCode.UNKNOWN,
		context: {},
		retryable: false,
	};
}

/**
 * Check if an error is retryable.
 *
 * @param error Error to check.
 * @returns True if retryable.
 */
export function isRetryable(error: unknown): boolean {
	if (error instanceof CloudflarePrometheusError) {
		return error.retryable;
	}

	// Network errors are generally retryable
	if (error instanceof TypeError && error.message.includes("fetch")) {
		return true;
	}

	return false;
}

/**
 * Wrap an unknown error as a CloudflarePrometheusError.
 *
 * @param error Error to wrap.
 * @param message Error message.
 * @param code Error code.
 * @param context Error context.
 * @returns Wrapped error.
 */
export function wrapError(
	error: unknown,
	message: string,
	code: ErrorCode = ErrorCode.UNKNOWN,
	context?: ErrorContext,
): CloudflarePrometheusError {
	if (error instanceof CloudflarePrometheusError) {
		// Already our error type, just add context if needed
		if (context) {
			return new CloudflarePrometheusError(message, error.code, {
				cause: error,
				context: { ...error.context, ...context },
				retryable: error.retryable,
			});
		}
		return error;
	}

	return new CloudflarePrometheusError(message, code, {
		cause: error instanceof Error ? error : undefined,
		context,
	});
}
