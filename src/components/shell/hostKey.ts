import { useSyncExternalStore } from "react";
import { api, isApiError } from "../../lib/api";
import type { HostKeyInfo } from "../../types";

export type HostKeyStep = "trust" | "mismatch";

/** Which host-key dialog an error asks for, or null when it isn't a host-key error. */
export function hostKeyStep(e: unknown): HostKeyStep | null {
  if (isApiError(e, "hostKeyUnknown") && e.hostKey) return "trust";
  if (isApiError(e, "hostKeyMismatch") && e.hostKey) return "mismatch";
  return null;
}

export interface HostKeyPrompt {
  step: HostKeyStep;
  hostKey: HostKeyInfo;
  /** true = trust (only meaningful for "trust"). */
  resolve: (trust: boolean) => void;
}

// One prompt at a time; a second connect hitting a host-key error waits its turn.
let queue: HostKeyPrompt[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Shows the host-key dialog and resolves with the user's decision. */
export function askHostKey(step: HostKeyStep, hostKey: HostKeyInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const prompt: HostKeyPrompt = {
      step,
      hostKey,
      resolve: (trust) => {
        queue = queue.filter((p) => p !== prompt);
        emit();
        resolve(trust);
      },
    };
    queue = [...queue, prompt];
    emit();
  });
}

/** The prompt the dialog should show now. */
export const useHostKeyPrompt = () => useSyncExternalStore(subscribe, () => queue[0] ?? null);

/**
 * Runs `call`; on an unknown host key asks the user and, on trust, stores the key and retries exactly once.
 * A changed key only shows the warning (never retried). Host-key errors are rethrown when not resolved, so
 * callers can tell them apart with `hostKeyStep` (the dialog already told the user).
 */
export async function withHostKey<T>(
  call: () => Promise<T>,
  deps: { ask: typeof askHostKey; trust: (k: HostKeyInfo) => Promise<void> } = { ask: askHostKey, trust: api.trustHostKey },
): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const step = hostKeyStep(e);
    if (!step) throw e;
    const hostKey = (e as { hostKey: HostKeyInfo }).hostKey;
    const trusted = await deps.ask(step, hostKey);
    if (step === "mismatch" || !trusted) throw e;
    await deps.trust(hostKey);
    return await call();
  }
}
