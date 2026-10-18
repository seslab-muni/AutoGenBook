import { ApiError } from '@/api/client';

/** The server's own message for a failed request (problem detail or title), else a plain network hint. */
export function problemMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail || error.problem?.title || error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Check your connection and try again.';
}
