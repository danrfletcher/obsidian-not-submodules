/** Extracts a human-readable message from a caught value without relying on `any`. */
export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
