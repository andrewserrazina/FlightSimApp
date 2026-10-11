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
}

/** All keys supabase-js uses are packed into one secure entry (JSON map). */
export async function createSecureSessionStorage(backend: SecureBackend | null): Promise<SessionStorageAdapter> {
  let persistent = false;
  let cache: Record<string, string> = {};
  if (backend) {
    try {
      persistent = await backend.available();
      if (persistent) {
        const raw = await backend.get();
        const parsed = raw ? (JSON.parse(raw) as unknown) : {};
        cache = parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
      }
    } catch {
      persistent = false;
      cache = {};
    }
  }
  const flush = async () => {
    if (!persistent || !backend) return;
    try {
      if (Object.keys(cache).length === 0) await backend.remove();
      else await backend.set(JSON.stringify(cache));
    } catch {
      // Secure store failed mid-session: keep working from memory; never fall back to plaintext.
    }
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
