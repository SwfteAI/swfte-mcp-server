const history: Array<{ at: string; status: string }> = [];

/** Keeps the last 30 digest runs for the ops dashboard. */
export async function recordDigest(run: { status: string; executionId: string }): Promise<void> {
  history.unshift({ at: new Date().toISOString(), status: `${run.executionId}:${run.status}` });
  history.length = Math.min(history.length, 30);
}
