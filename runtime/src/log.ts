/** Structured-enough logging for a single-household system: one line, JSON payload. */

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env["LOG_LEVEL"] as Level) ?? "info"] ?? order.info;

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (order[level] < threshold) return;
    const line = fields && Object.keys(fields).length > 0 ? `${message} ${JSON.stringify(fields)}` : message;
    const stamp = new Date().toISOString();
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](`${stamp} ${level.toUpperCase().padEnd(5)} ${line}`);
}

export const log = {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};

/** Errors are logged everywhere; this keeps the shape consistent. */
export function describeError(error: unknown): string {
    if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
    return String(error);
}
