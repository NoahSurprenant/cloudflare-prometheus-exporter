import { createConsola, type LogObject } from "consola";

// Raw ANSI escape codes - bypass consola's color detection which doesn't work in wrangler dev
const ansi = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
};

const c = {
	dim: (s: string) => `${ansi.dim}${s}${ansi.reset}`,
	red: (s: string) => `${ansi.red}${s}${ansi.reset}`,
	green: (s: string) => `${ansi.green}${s}${ansi.reset}`,
	yellow: (s: string) => `${ansi.yellow}${s}${ansi.reset}`,
	cyan: (s: string) => `${ansi.cyan}${s}${ansi.reset}`,
	white: (s: string) => `${ansi.white}${s}${ansi.reset}`,
	gray: (s: string) => `${ansi.gray}${s}${ansi.reset}`,
	magenta: (s: string) => `${ansi.magenta}${s}${ansi.reset}`,
};

/**
 * Log severity levels.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Output format: json for structured logs, pretty for human-readable.
 */
export type LogFormat = "json" | "pretty";

/**
 * Key-value pairs attached to log entries.
 */
export type StructuredData = Record<string, unknown>;

/**
 * Structured logger with level methods, namespacing, and context.
 */
export interface Logger {
	/**
	 * Log debug message.
	 *
	 * @param msg Message text.
	 * @param data Optional structured data.
	 */
	debug(msg: string, data?: StructuredData): void;

	/**
	 * Log info message.
	 *
	 * @param msg Message text.
	 * @param data Optional structured data.
	 */
	info(msg: string, data?: StructuredData): void;

	/**
	 * Log warning message.
	 *
	 * @param msg Message text.
	 * @param data Optional structured data.
	 */
	warn(msg: string, data?: StructuredData): void;

	/**
	 * Log error message.
	 *
	 * @param msg Message text.
	 * @param data Optional structured data.
	 */
	error(msg: string, data?: StructuredData): void;

	/**
	 * Create child logger with namespaced tag.
	 *
	 * @param namespace Namespace appended to parent tag with colon separator.
	 * @returns New logger instance.
	 */
	child(namespace: string): Logger;

	/**
	 * Create logger with merged context data.
	 *
	 * @param ctx Context data merged into all log entries.
	 * @returns New logger instance.
	 */
	withContext(ctx: StructuredData): Logger;
}

/**
 * Logger configuration.
 */
export interface LoggerConfig {
	/** Output format, defaults to pretty. */
	format?: LogFormat;

	/** Minimum log level, defaults to info. */
	level?: LogLevel;
}

const LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
	debug: c.gray,
	info: c.cyan,
	warn: c.yellow,
	error: c.red,
};

const LEVEL_ICONS: Record<LogLevel, string> = {
	debug: "●",
	info: "◆",
	warn: "▲",
	error: "✖",
};

/**
 * Format current time as HH:MM:SS.
 *
 * @returns Formatted time string.
 */
function formatTime(): string {
	const now = new Date();
	return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

/**
 * Get current UTC timestamp in ISO format.
 *
 * @returns ISO 8601 timestamp string.
 */
function utcTimestamp(): string {
	return new Date().toISOString();
}

/**
 * Format value for display in logs.
 *
 * @param v Value to format.
 * @returns Formatted string representation.
 */
function formatValue(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return JSON.stringify(v);
}

/**
 * Format structured data as key=value pairs.
 *
 * @param data Structured data object.
 * @returns Formatted string with colored key-value pairs.
 */
function formatData(data: StructuredData): string {
	return Object.entries(data)
		.map(([k, v]) => `${c.dim(k)}=${c.white(formatValue(v))}`)
		.join(" ");
}

/**
 * Shorten tag for display: truncate zone/account IDs to 8 chars.
 *
 * @param tag Tag string to shorten.
 * @returns Shortened tag string.
 */
function shortenTag(tag: string): string {
	// Pattern: something:scope:longid:query -> something:scope:shortid:query
	return tag.replace(/([a-f0-9]{32})/g, (match) => match.slice(0, 8));
}

/**
 * Create pretty console reporter for human-readable logs.
 *
 * @param minLevel Minimum log level to output.
 * @returns Reporter object with log method.
 */
function createPrettyReporter(minLevel: LogLevel) {
	const minLevelNum = LEVELS[minLevel];

	return {
		log(logObj: LogObject) {
			const level = logObj.type as LogLevel;
			if (LEVELS[level] === undefined || LEVELS[level] < minLevelNum) return;

			const tag = logObj.tag || "app";
			const colorFn = LEVEL_COLORS[level] || c.white;
			const icon = LEVEL_ICONS[level] || "●";
			const args = logObj.args as [string, StructuredData?];
			const msg = args[0];
			const data = args[1];

			const time = c.dim(formatTime());
			const levelBadge = colorFn(`${icon} ${level.toUpperCase().padEnd(5)}`);
			const shortTag = c.dim(shortenTag(tag));
			const suffix = data ? ` ${formatData(data)}` : "";

			console.log(`${time} ${levelBadge} ${shortTag} ${msg}${suffix}`);
		},
	};
}

/**
 * Create JSON reporter for structured logs.
 *
 * @param minLevel Minimum log level to output.
 * @returns Reporter object with log method.
 */
function createJsonReporter(minLevel: LogLevel) {
	const minLevelNum = LEVELS[minLevel];

	return {
		log(logObj: LogObject) {
			const level = logObj.type as LogLevel;
			if (LEVELS[level] === undefined || LEVELS[level] < minLevelNum) return;

			const tagParts = (logObj.tag || "app").split(":");
			const [logger, ...namespaceParts] = tagParts;
			const namespace =
				namespaceParts.length > 0 ? namespaceParts.join(":") : undefined;

			const args = logObj.args as [string, StructuredData?];
			const msg = args[0];
			const data = args[1];

			console.log(
				JSON.stringify({
					ts: utcTimestamp(),
					logger,
					...(namespace && { namespace }),
					level,
					msg,
					...data,
				}),
			);
		},
	};
}

// Consola log levels: 0=silent, 1=error, 2=warn, 3=info, 4=debug, 5=trace
const CONSOLA_LEVELS: Record<LogLevel, number> = {
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

/**
 * Create logger instance with specified name and config.
 *
 * @param name Logger name, normalized to lowercase with underscores.
 * @param config Logger configuration.
 * @returns Configured logger instance.
 */
export function createLogger(name: string, config: LoggerConfig = {}): Logger {
	const format = config.format ?? "pretty";
	const level = config.level ?? "info";

	const reporter =
		format === "json" ? createJsonReporter(level) : createPrettyReporter(level);

	const consola = createConsola({
		level: CONSOLA_LEVELS[level],
		reporters: [reporter],
	});

	function makeLogger(tag: string, baseContext: StructuredData = {}): Logger {
		const instance = consola.withTag(tag);

		const mergeData = (data?: StructuredData): StructuredData | undefined => {
			if (!data && Object.keys(baseContext).length === 0) return undefined;
			if (!data) return baseContext;
			return { ...baseContext, ...data };
		};

		return {
			debug: (msg, data) => instance.debug(msg, mergeData(data)),
			info: (msg, data) => instance.info(msg, mergeData(data)),
			warn: (msg, data) => instance.warn(msg, mergeData(data)),
			error: (msg, data) => instance.error(msg, mergeData(data)),
			child: (ns) => makeLogger(`${tag}:${ns}`, baseContext),
			withContext: (ctx) => makeLogger(tag, { ...baseContext, ...ctx }),
		};
	}

	const normalizedName = name.toLowerCase().replace(/[ -]/g, "_");
	return makeLogger(normalizedName);
}

/**
 * Create logger config from Cloudflare Worker env.
 *
 * @param env Environment object with LOG_FORMAT and LOG_LEVEL.
 * @returns Logger configuration.
 */
export function configFromEnv(env: {
	LOG_FORMAT?: string;
	LOG_LEVEL?: string;
}): LoggerConfig {
	const format = env.LOG_FORMAT;
	const level = env.LOG_LEVEL;
	return {
		format: format === "json" || format === "pretty" ? format : "pretty",
		level:
			level === "debug" ||
			level === "info" ||
			level === "warn" ||
			level === "error"
				? level
				: "info",
	};
}
