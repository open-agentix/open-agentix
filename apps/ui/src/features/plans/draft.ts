const KEY = 'oax.agentDraft';

/** Hands a generated draft to the normal "new agent" editor (it is only saved there). */
export function stashAgentDraft(source: string): void {
  try {
    window.sessionStorage.setItem(KEY, source);
  } catch {
    /* storage blocked: the draft can still be copied */
  }
}

/** Returns the stashed draft once and forgets it. */
export function takeAgentDraft(): string | null {
  try {
    const value = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}
