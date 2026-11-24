/** Host surface seam allowing shells to wire SPA links, schema fields, URL params, and catalog words into `@mistriwork/ui`. */
import { createContext, useContext, type MouseEvent, type ReactNode, type Ref } from 'react';

/** Enclosing card context describing whether a component stands inside a `Card` and at what heading level. */
export type CardFrame = false | { titled: boolean; level: 2 | 3 | 4 };

/** React context tracking the nearest enclosing `Card` frame. */
export const InCardContext = createContext<CardFrame>(false);

/** Read the nearest enclosing `Card` frame (`false` when standing outside a `Card`). */
export const useInCard = (): CardFrame => useContext(InCardContext);

/** Host hooks and render adapters plugged into `@mistriwork/ui` without cross-layer imports. */
export interface UiSurfaceSeam {
  useLinkProps?: (
    href: string | undefined,
    onClick?: (event: MouseEvent<HTMLElement>) => void,
  ) => { href?: string; onClick?: (event: MouseEvent<HTMLElement>) => void };
  renderRecordFacts?: (props: {
    resource: string;
    row: Readonly<Record<string, unknown>>;
    fields: ReadonlyArray<string | { field: string; label?: ReactNode } | { id?: string; label: ReactNode; value: ReactNode }>;
    columns?: 1 | 2 | 3;
    className?: string;
    ref?: Ref<HTMLDListElement>;
  }) => ReactNode;
  renderPaneSplit?: (props: Record<string, unknown>) => ReactNode;
  useUrlParam?: (param: string | undefined) => readonly [string | undefined, (next: string | undefined) => void];
  aiLabel?: () => string;
  defaultWords?: () => {
    select?: string;
    close?: string;
    chooseFile?: string;
    chooseFiles?: string;
    noFileChosen?: string;
    empty?: string;
    backTo?: (label: string) => string;
  };
  formatPreset?: (value: number, preset: 'number' | 'money' | 'percent', locale?: string) => string;
  defaultPageHeaderLevel?: 1 | 2;
}

let installedSeam: UiSurfaceSeam | null = null;

/** React context overriding the process-level installed `UiSurfaceSeam` for a subtree. */
export const UiSurfaceSeamContext = createContext<UiSurfaceSeam | null>(null);

/** Read the active `UiSurfaceSeam` from context or the installed default seam. */
export function useSurfaceSeam(): UiSurfaceSeam | null {
  return useContext(UiSurfaceSeamContext) ?? installedSeam;
}

/** Install or merge default host `UiSurfaceSeam` fields used outside an explicit `UiSurfaceSeamContext.Provider`. */
export function installSurfaceSeam(seam: UiSurfaceSeam | null): void {
  if (seam === null) {
    installedSeam = null;
    return;
  }
  const prev = installedSeam;
  const prevWords = prev?.defaultWords;
  const nextWords = seam.defaultWords;
  installedSeam = {
    ...prev,
    ...seam,
    ...(prevWords || nextWords
      ? {
          defaultWords: () => ({
            ...prevWords?.(),
            ...nextWords?.(),
          }),
        }
      : {}),
  };
}
