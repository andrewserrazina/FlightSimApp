/**
 * Storage adapter for supabase-js that keeps ALL session material (access + refresh tokens) in the
 * OS secure credential store via the native shell (src-tauri/src/secure.rs). Never localStorage,
 * never preferences, never files. If the secure store is unavailable the session lives in memory
 * only for this run (the user signs in again next launch).
 */
export interface SecureBackend {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
  available(): Promise<boolean>;
}

export interface SessionStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** True when items persist in OS secure storage across restarts. */
  readonly persistent: boolean;
  /** Remove every key matching `predicate` (one secure write). */
  prune(predicate: (key: string) => boolean): Promise<void>;
}

/**
 * Only a JSON object whose values are all strings is accepted from the secure store. Anything else
 * (truncated JSON, null, arrays, numbers, nested objects — e.g. a damaged or foreign entry) is
 * ignored as "no session": it is never handed to supabase-js and is replaced by the next write.
 */
export function parseSecureEntry(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>);
    return entries.every(([, v]) => typeof v === "string") ? (Object.fromEntries(entries) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** All keys supabase-js uses are packed into one secure entry (JSON map). */
export async function createSecureSessionStorage(backend: SecureBackend | null): Promise<SessionStorageAdapter> {
  let persistent = false;
  let cache: Record<string, string> = {};
  if (backend) {
    try {
      persistent = await backend.available();
      if (persistent) cache = parseSecureEntry(await backend.get());
    } catch {
      persistent = false;
      cache = {};
    }
  }
  // Writes are serialised and each writes the latest snapshot, so overlapping set/remove calls can
  // never reach the OS store out of order (a stale write can't resurrect or clobber a session).
  let queue: Promise<void> = Promise.resolve();
  const flush = () => {
    if (!persistent || !backend) return Promise.resolve();
    queue = queue.then(async () => {
      try {
        if (Object.keys(cache).length === 0) await backend.remove();
        else await backend.set(JSON.stringify(cache));
      } catch {
        // Secure store failed mid-session: keep working from memory; never fall back to plaintext.
      }
    });
    return queue;
  };
  return {
    get persistent() {
      return persistent;
    },
    getItem: async (key) => cache[key] ?? null,
    setItem: async (key, value) => {
      cache[key] = value;
      await flush();
    },
    removeItem: async (key) => {
      delete cache[key];
      await flush();
    },
    prune: async (predicate) => {
      const doomed = Object.keys(cache).filter(predicate);
      if (doomed.length === 0) return;
      doomed.forEach((k) => delete cache[k]);
      await flush();
    },
  };
}

export async function createTauriSecureBackend(): Promise<SecureBackend> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    get: () => invoke<string | null>("secure_session_get"),
    set: (value) => invoke("secure_session_set", { value }),
    remove: () => invoke("secure_session_delete"),
    available: () => invoke<boolean>("secure_storage_status"),
  };
}
