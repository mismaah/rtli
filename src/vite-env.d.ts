/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the rtl-improved backend, e.g. `https://api.example.com`.
   *
   * Optional by design. With it unset the app calls RTL directly, exactly as it
   * did before the server existed — the server is an accelerator, never a
   * dependency.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
