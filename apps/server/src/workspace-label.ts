/**
 * Shared workspace display-label derivation, used by `/workspaces` and by
 * `/usage/spend` (T-98) so both surfaces name the same `cwd` identically.
 */

/** Human-readable label for a workspace path: its final path segment. */
export function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
