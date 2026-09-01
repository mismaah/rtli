/**
 * Where the app gets its data.
 *
 * The backend is optional. When `VITE_API_BASE` is unset — or when the server
 * is unreachable at runtime — every request falls back to calling RTL directly,
 * which is what the app did before the server existed. Nothing the server
 * serves is something the client cannot also derive on its own.
 */
const rawBase = import.meta.env?.VITE_API_BASE?.trim() ?? '';

/** Backend base URL with any trailing slash removed, or null when unconfigured. */
export const API_BASE: string | null = rawBase ? rawBase.replace(/\/+$/, '') : null;

export const hasBackend = API_BASE !== null;
