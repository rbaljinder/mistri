/*
 * The few router hooks the adapters call, declared here rather than taken from
 * the routers' own packages: mistri depends on none of them. A host has
 * the one it uses installed, and its bundler resolves the import; these
 * declarations only let this repository typecheck the adapters without them.
 */
declare module 'react-router' {
  export function useNavigate(): (to: string, options?: { replace?: boolean; state?: unknown }) => void | Promise<void>;
  export function useLocation(): { pathname: string; search: string; hash: string; state: unknown; key: string };
}

declare module 'next/navigation' {
  export function usePathname(): string | null;
  export function useSearchParams(): { toString(): string } | null;
}

declare module '@tanstack/react-router' {
  interface HistoryLocation {
    pathname: string;
    search: string;
    state: unknown;
  }
  export function useRouter(): {
    history: {
      location: HistoryLocation;
      push(path: string, state?: unknown): void;
      replace(path: string, state?: unknown): void;
      subscribe(listener: () => void): () => void;
    };
  };
}
