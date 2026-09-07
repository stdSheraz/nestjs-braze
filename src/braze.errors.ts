/**
 * Braze failures arrive as braze-api's `ResponseError`, which carries the HTTP
 * status and Braze's per-field `errors` array (e.g. `EMAIL_BAD_FORMAT`) on top
 * of the message. A plain `error.message` throws both away — and Braze's
 * message for a rejected payload is the generic "Valid data must be provided
 * in the 'attributes', 'events', or 'purchases' fields", which says nothing
 * about *which* field it disliked. These helpers keep that detail.
 */

/** A Braze failure, flattened to the bits worth logging. */
export interface BrazeErrorDetails {
  message: string;
  name?: string;
  stack?: string;
  /** HTTP status Braze returned, when the failure came from the API itself. */
  status?: number;
  /** Braze's per-field error codes — the part that names the bad field. */
  errors?: unknown;
}

/** Pull the loggable detail off an unknown thrown value. */
export function extractBrazeError(error: unknown): BrazeErrorDetails {
  const err = error instanceof Error ? error : undefined;
  const details: BrazeErrorDetails = {
    message: err?.message ?? String(error),
    name: err?.name,
    stack: err?.stack,
  };

  // Duck-typed: ResponseError isn't re-exported from braze-api's entrypoint.
  const candidate = error as { status?: unknown; errors?: unknown } | null;
  if (candidate && typeof candidate === 'object') {
    if (typeof candidate.status === 'number') details.status = candidate.status;
    if (candidate.errors !== undefined) details.errors = candidate.errors;
  }

  return details;
}

/**
 * Render the Braze-specific extras as a ` (status=400 errors=[...])` suffix.
 * Empty string when there is nothing extra to say, so it appends cleanly.
 */
export function formatBrazeErrorDetails(
  details: BrazeErrorDetails,
  maxLength = 2000,
): string {
  const parts: string[] = [];
  if (details.status !== undefined) parts.push(`status=${details.status}`);

  if (details.errors !== undefined) {
    let text: string;
    try {
      text = JSON.stringify(details.errors) ?? String(details.errors);
    } catch {
      text = String(details.errors);
    }
    if (maxLength > 0 && text.length > maxLength) {
      text = `${text.slice(0, maxLength)}… (truncated)`;
    }
    parts.push(`errors=${text}`);
  }

  return parts.length ? ` (${parts.join(' ')})` : '';
}
