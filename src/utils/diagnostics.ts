export type DiagnosticLevel = "info" | "warn" | "error";

let traceSequence = 0;

const now = (): number => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

const stringifyDetails = (details?: Record<string, unknown>): string => {
  if (!details) return "";
  try {
    return JSON.stringify(details);
  } catch (_error) {
    return "{\"details\":\"<unserializable>\"}";
  }
};

export const createDiagnosticTraceId = (prefix = "render"): string => {
  traceSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${traceSequence.toString(36)}`;
};

export const diagnosticLog = (
  level: DiagnosticLevel,
  scope: string,
  event: string,
  details?: Record<string, unknown>
): void => {
  const suffix = stringifyDetails(details);
  const message = `[DIAG][Kookit][${scope}] ${event}${suffix ? " " + suffix : ""}`;
  try {
    if (level === "error") {
      console.error(message);
    } else if (level === "warn") {
      console.warn(message);
    } else {
      console.info(message);
    }
  } catch (_error) {
    // Diagnostics must never break the reading pipeline.
  }
};

export const beginDiagnostic = (
  scope: string,
  event: string,
  details?: Record<string, unknown>
): ((result?: Record<string, unknown>) => void) => {
  const startedAt = now();
  let finished = false;
  diagnosticLog("info", scope, `${event}:start`, details);
  return (result?: Record<string, unknown>) => {
    if (finished) return;
    finished = true;
    const durationMs = Math.round((now() - startedAt) * 10) / 10;
    diagnosticLog("info", scope, `${event}:end`, {
      ...(result || {}),
      durationMs,
    });
  };
};

export const diagnosticError = (
  scope: string,
  event: string,
  error: unknown,
  details?: Record<string, unknown>
): void => {
  const errorDetails =
    error instanceof Error
      ? {
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
        }
      : { errorMessage: String(error) };
  diagnosticLog("error", scope, event, {
    ...(details || {}),
    ...errorDetails,
  });
};
