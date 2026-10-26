/** Existing DSL room, loaded only for the private Console App. All requests
 * use Console endpoints, never target-App transports that omit its fence. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Empty, Icon, Stack, useViewer } from '@mistriwork/mistri/ui';
import { useAddressState } from '@mistriwork/mistri/page';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../../copy/console/components/console/ConsoleRoom.js';
import { consoleRequest, type ConsoleRequest, type Target, type FlagRow } from './model.js';
import { ConsoleHead, ConsoleSplit, rememberApp, useListKeys, type PaletteEntry } from './ConsoleShell.js';
import { FlagFilters, FlagTable, KIND, filtered, type FlagFilter } from './FlagTable.js';
import { FlagRecord } from './FlagSheet.js';
import './ConsoleRoom.css';

function useRead<T>(request: ConsoleRequest, path: string | undefined, revision?: number, keep = false) {
  const [state, setState] = useState<{
    path: string;
    request: ConsoleRequest;
    revision?: number;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!path) return;
    let current = true;
    const cancel = new AbortController();
    void request<T>(path, undefined, cancel.signal).then(
      (data) => {
        if (current) setState({ path, request, revision, data });
      },
      (error: Error) => {
        if (current) setState({ path, request, revision, error: error.message });
      },
    );
    return () => {
      current = false;
      cancel.abort();
    };
  }, [request, path, revision]);
  // A list read again after a change keeps its rows on screen until the new ones arrive.
  return state && state.path === path && state.request === request && (keep || state.revision === revision) ? state : undefined;
}

export default function ConsoleRoom({ props }: { props: { endpoint: string } }) {
  useMessageLanguage();
  const viewer = useViewer(),
    [scope, setScope] = useAddressState('scope'),
    [flag, setFlag] = useAddressState('flag');
  const [target, setTarget] = useAddressState('target');
  const request = useMemo(() => consoleRequest(props.endpoint, viewer.account ?? ''), [props.endpoint, viewer.account]);
  if (!viewer.signedIn || !viewer.account) return <Empty title={say('signIn')} />;
  // Closing refines this room. A pushed navigation remounts its owner before
  // the modal can hand focus back to the freshly authorized list.
  return (
    <ConsolePanel
      key={viewer.account}
      request={request}
      scopeId={scope}
      flagId={flag}
      targetScopeId={target}
      selectTarget={(id) => {
        setFlag(undefined);
        setScope(undefined);
        setTarget(id, { push: true });
      }}
      selectScope={(id, replace) => {
        setFlag(undefined);
        setScope(id, { push: !replace });
      }}
      selectFlag={(id) => setFlag(id, { push: id !== undefined })}
    />
  );
}

export { FlagRecord };

/** The other scopes' rows, read beside the open one so the list shows each flag's state in every scope. */
function useScopeRows(request: ConsoleRequest, scopes: readonly { id: string }[], reload: number) {
  const [rows, setRows] = useState<{
    key: string;
    maps: Array<ReadonlyMap<string, FlagRow> | undefined>;
  }>();
  const key = scopes.map((scope) => scope.id).join('|');
  useEffect(() => {
    if (!scopes.length) return;
    let current = true;
    const cancel = new AbortController();
    setRows((old) => (old?.key === key ? old : { key, maps: scopes.map(() => undefined) }));
    scopes.forEach((scope, index) => {
      void request<{ items: FlagRow[] }>(`/scopes/${encodeURIComponent(scope.id)}/flags`, undefined, cancel.signal).then(
        (data) => {
          if (!current) return;
          setRows((old) => {
            const maps = old?.key === key ? [...old.maps] : scopes.map(() => undefined);
            maps[index] = new Map(data.items.map((item) => [item.flagId, item]));
            return { key, maps };
          });
        },
        () => undefined,
      );
    });
    return () => {
      current = false;
      cancel.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the scopes
  }, [request, key, reload]);
  return rows?.key === key ? rows.maps : scopes.map(() => undefined);
}

/** At most this many scopes stand side by side as state columns; the rest are a choice in the head. */
const SCOPE_COLUMNS = 4;

export function ConsolePanel({
  request,
  scopeId,
  flagId,
  targetScopeId,
  selectTarget,
  selectScope,
  selectFlag,
}: {
  request: ConsoleRequest;
  scopeId?: string;
  flagId?: string;
  targetScopeId?: string;
  selectTarget(id: string): void;
  /** `replace` when the room chose for the reader (the only scope), so Back does not land on the choice again. */
  selectScope(id: string | undefined, replace?: boolean): void;
  selectFlag(id: string | undefined): void;
}) {
  useMessageLanguage();
  // An authorized scope handle identifies the target across room remounts and
  // rotating catalog IDs. It is only a catalog hint until a scope is selected.
  const catalogScope = scopeId ?? targetScopeId;
  const catalog = useRead<{ targets: Target[] }>(request, `/catalog${catalogScope ? `?scope=${encodeURIComponent(catalogScope)}` : ''}`);
  const [query, setQuery] = useState('');
  // Closing revalidates and remounts the list with fresh opaque handles. Match
  // the flag's name only after this same account/scope authorizes it again.
  const returnTo = useRef<{ flagId: string; request: ConsoleRequest; scopeId: string | undefined } | undefined>(undefined);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const focusOwner = useRef({ request, scopeId, flagId });
  focusOwner.current = { request, scopeId, flagId };
  const [filter, setFilter] = useState<FlagFilter>({}),
    [reload, setReload] = useState(0);
  useEffect(() => {
    setQuery('');
    setFilter({});
    returnTo.current = undefined;
  }, [scopeId, request]);
  const targets = catalog?.data?.targets ?? [];
  const target = targets.find((item) => item.scopes.some((scope) => scope.id === catalogScope)) ?? targets[0];
  const scopeKnown = !!scopeId && !!target?.scopes.some((item) => item.id === scopeId);
  /* One scope is no choice: open it, replacing the address so Back leaves the room rather than returning here. */
  const only = target && target.scopes.length === 1 ? target.scopes[0].id : undefined;
  useEffect(() => {
    if (!only || scopeId) return;
    /* After the commit, not inside it: the address change re-renders the shell, which React will not do mid-commit. */
    let current = true;
    queueMicrotask(() => {
      if (current) selectScope(only, true);
    });
    return () => {
      current = false;
    };
  }, [only, scopeId, selectScope]);
  const flags = useRead<{ environment: string; items: FlagRow[] }>(
    request,
    scopeId ? `/scopes/${encodeURIComponent(scopeId)}/flags${flagId ? `?flag=${encodeURIComponent(flagId)}` : ''}` : undefined,
    reload,
    true,
  );
  const others = useMemo(
    () => (scopeKnown && target ? target.scopes.filter((item) => item.id !== scopeId).slice(0, SCOPE_COLUMNS - 1) : []),
    [scopeKnown, target, scopeId],
  );
  const otherRows = useScopeRows(request, others, reload);
  const items = flags?.data?.items ?? [];
  const visible = filtered(items, filter, query);
  const selected = scopeKnown ? items.find((item) => item.id === flagId) : undefined;
  const open = target?.scopes.find((item) => item.id === scopeId);
  const close = () => {
    if (selected) returnTo.current = { flagId: selected.flagId, request, scopeId };
    selectFlag(undefined);
  };
  useListKeys(listRef, selected ? close : undefined);
  useEffect(() => {
    const pending = returnTo.current,
      node = pending && rowButtons.current.get(pending.flagId);
    if (!pending || !node || flagId || pending.request !== request || pending.scopeId !== scopeId) return;
    // Ref attachment precedes Modal's teardown/focus restoration. Wait until
    // that cleanup has finished; a newer owner must never inherit this focus.
    const frame = requestAnimationFrame(() => {
      const owner = focusOwner.current;
      if (returnTo.current !== pending || owner.request !== request || owner.scopeId !== scopeId || owner.flagId || !node.isConnected)
        return;
      returnTo.current = undefined;
      node.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [request, scopeId, flagId, flags, catalog, query]);
  const entries: PaletteEntry[] = items.map((item) => ({
    id: `flag:${item.id}`,
    group: say('flags'),
    label: item.flagId,
    detail: [item.kind && KIND[item.kind](), item.owner].filter(Boolean).join(' · ') || undefined,
    run: () => {
      returnTo.current = undefined;
      selectFlag(item.id);
    },
  }));
  const apps = targets.map((item) => ({ id: item.id, name: item.name }));
  const chooseApp = (app: { id: string; name: string }) => {
    const next = targets.find((item) => item.id === app.id),
      choice = next?.scopes[0];
    if (next && choice) {
      rememberApp({ name: next.name });
      selectTarget(choice.id);
    }
  };
  return (
    <Stack className={`console-workspace${selected ? ' console-has-selection' : ''}`}>
      {catalog?.error && <p role="alert">{catalog.error}</p>}
      {!catalog ? (
        <p role="status">{say('loadingApps')}</p>
      ) : !targets.length ? (
        <Empty title={say('noTargets')} />
      ) : (
        <>
          <ConsoleHead
            title={say('title')}
            apps={apps}
            app={target && { id: target.id, name: target.name }}
            onApp={chooseApp}
            entries={entries}
            context={
              <>
                {target && target.scopes.length > 1 && (
                  <div className="console-switcher">
                    <Dropdown
                      ariaLabel={say('scope')}
                      value={scopeId ?? ''}
                      items={[
                        ...(scopeId ? [] : [{ value: '', label: say('chooseScope') }]),
                        ...target.scopes.map((item) => ({
                          value: item.id,
                          label: item.label,
                        })),
                      ]}
                      onChange={(value) => {
                        selectFlag(undefined);
                        selectScope(value || undefined);
                      }}
                    />
                  </div>
                )}
                <span className="console-context-group">
                  {target && target.scopes.length === 1 && <span className="console-context">{target.scopes[0].label}</span>}
                  {target?.environment && (
                    <span className="console-env" aria-label={say('environment')}>
                      {target.environment}
                    </span>
                  )}
                </span>
              </>
            }
          >
            {scopeId && flags?.data && (
              <div className="console-toolbar console-flag-tools">
                <FlagFilters rows={items} filter={filter} onFilter={setFilter} />
                <span className="console-count" role="status">
                  {say('flagCount', {
                    shown: visible.length,
                    total: items.length,
                  })}
                </span>
                <span className="console-search">
                  <span className="console-search-icon" aria-hidden="true">
                    <Icon name="magnifying-glass" size={14} />
                  </span>
                  <input
                    type="search"
                    aria-label={say('searchFlags')}
                    placeholder={say('searchPlaceholder')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query && (
                    <Button size="compact" intent="quiet" onClick={() => setQuery('')}>
                      {say('clearSearch')}
                    </Button>
                  )}
                </span>
              </div>
            )}
          </ConsoleHead>
          {!scopeId ? (
            only ? (
              <p role="status" className="console-reading">
                {say('loadingFlags')}
              </p>
            ) : (
              <section className="console-scope-choice" aria-label={say('chooseScope')}>
                <p className="console-caption">{say('scopeHint')}</p>
                <ul className="console-scope-list">
                  {target?.scopes.map((item) => (
                    <li key={item.id}>
                      <button type="button" className="console-scope-card" data-list-key onClick={() => selectScope(item.id)}>
                        <strong>{item.label}</strong>
                        <span className="console-caption">{target.environment}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          ) : (
            <>
              {flags?.error && <p role="alert">{flags.error}</p>}
              {!flags ? (
                <p role="status" className="console-reading">
                  {say('loadingFlags')}
                </p>
              ) : (
                flags.data && (
                  <div ref={listRef} className="console-list-keys">
                    <ConsoleSplit
                      className="console-split"
                      sentenceTitle
                      expandList
                      selected={!!selected}
                      detailTitle={selected?.flagId}
                      listLabel={say('flags')}
                      detailLabel={say('flagDetails')}
                      onCloseDetail={close}
                      detail={
                        selected && (
                          <FlagRecord
                            key={`${scopeId}:${selected.id}`}
                            request={request}
                            id={selected.id}
                            onChanged={() => setReload((value) => value + 1)}
                          />
                        )
                      }
                      list={
                        !items.length ? (
                          <Empty title={say('noFlags')} />
                        ) : !visible.length ? (
                          query.trim() ? (
                            <Empty title={say('noMatches')} />
                          ) : (
                            <Empty title={say('noneFiltered')} />
                          )
                        ) : (
                          <FlagTable
                            request={request}
                            rows={visible}
                            chosen={flagId}
                            onChanged={() => setReload((value) => value + 1)}
                            scopes={[
                              { label: open?.label ?? '' },
                              ...others.map((item, index) => ({
                                label: item.label,
                                rows: otherRows[index],
                              })),
                            ]}
                            rowRef={(name, node) => {
                              if (node) rowButtons.current.set(name, node);
                              else rowButtons.current.delete(name);
                            }}
                            onOpen={(item) => {
                              returnTo.current = undefined;
                              selectFlag(item.id);
                            }}
                          />
                        )
                      }
                    />
                  </div>
                )
              )}
            </>
          )}
        </>
      )}
    </Stack>
  );
}
