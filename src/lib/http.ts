// Small HTTP helpers — uniform JSON errors + responses.
import type { Context } from 'hono';

export interface ApiError {
  error: string;
  code?: string;
  hint?: string;
}

export function jsonError(
  c: Context,
  status: number,
  message: string,
  extra?: Partial<ApiError>,
) {
  return c.json<ApiError>({ error: message, ...extra }, status as any);
}
