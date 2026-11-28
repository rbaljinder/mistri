/**
 * Inspectable Memory Drawer for the in-App assistant (loaded on demand when
 * the person clicks "Memory" or "Manage" on a memory chip).
 *
 * Lists durable personal (`person`) and shared workspace (`app`) notes fetched
 * from `/api/assistant/memories`, letting the person filter, add, edit, or
 * delete memories at any time while respecting `sharedRoles` on workspace notes.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Select } from '@mistriwork/ui/Select.js';
import { assistantApi } from './assistantRequest.js';
import { say } from '../copy/shell/components/AssistantMemoryDrawer.js';
import './AssistantMemoryDrawer.css';

interface StoredMemoryRow {
  id: string;
  scope: 'person' | 'app';
  agent: string;
  content: string;
  source: 'assistant' | 'person';
  createdAt: string;
  updatedAt: string;
}

interface MemoriesPayload {
  memories: StoredMemoryRow[];
  scopes: Array<'person' | 'app'>;
  maxItems: number;
  canWriteShared: boolean;
}

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function formatMemoryDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const now = new Date();
  if (parsed.getFullYear() === now.getFullYear() && parsed.getMonth() === now.getMonth() && parsed.getDate() === now.getDate()) {
    return say('memoryToday');
  }
  return shortDate.format(parsed);
}

export function AssistantMemoryDrawer({ app, onClose }: { app: string; onClose: () => void }) {
  const [data, setData] = useState<MemoriesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftScope, setDraftScope] = useState<'person' | 'app'>('person');
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await assistantApi(`/api/assistant/memories?app=${encodeURIComponent(app)}`)) as MemoriesPayload;
      setData(res);
      if (res.scopes.length && !res.scopes.includes(draftScope)) {
        setDraftScope(res.scopes[0]!);
      }
    } catch (err) {
      setError(say('memoryLoadError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoading(false);
    }
  }, [app, draftScope]);

  useEffect(() => {
    void load();
  }, [load]);

  const canAddShared = Boolean(data?.scopes.includes('app') && data?.canWriteShared);
  const canAddPersonal = Boolean(data?.scopes.includes('person'));
  const canAddAny = canAddPersonal || canAddShared;

  const saveDraft = async () => {
    const content = draft.trim();
    if (!content || saving) return;
    const scope: 'person' | 'app' = canAddPersonal && canAddShared ? draftScope : canAddPersonal ? 'person' : 'app';
    setSaving(true);
    setError(null);
    try {
      await assistantApi('/api/assistant/memories', { app, content, scope });
      setDraft('');
      await load();
    } catch (err) {
      setError(say('memorySaveError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    await saveDraft();
  };

  const handleDraftKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void saveDraft();
    }
  };

  const handleEditSave = async (row: StoredMemoryRow) => {
    const content = editingText.trim();
    if (!content || saving) return;
    setSaving(true);
    setError(null);
    try {
      await assistantApi('/api/assistant/memories', { app, id: row.id, scope: row.scope, content });
      setEditingId(null);
      setEditingText('');
      await load();
    } catch (err) {
      setError(say('memorySaveError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  };

  const handleEditKey = (event: KeyboardEvent<HTMLTextAreaElement>, row: StoredMemoryRow) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleEditSave(row);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEditingId(null);
      setEditingText('');
    }
  };

  const handleDelete = async (id: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await assistantApi('/api/assistant/memories/delete', { app, id });
      setData((prev) => (prev ? { ...prev, memories: prev.memories.filter((item) => item.id !== id) } : prev));
    } catch (err) {
      setError(say('memorySaveError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  };

  const trimmedFilter = filter.trim().toLowerCase();
  const visibleMemories = useMemo(() => {
    const all = data?.memories ?? [];
    if (!trimmedFilter) return all;
    return all.filter((item) => item.content.toLowerCase().includes(trimmedFilter));
  }, [data?.memories, trimmedFilter]);

  const personalItems = visibleMemories.filter((item) => item.scope === 'person');
  const sharedItems = visibleMemories.filter((item) => item.scope === 'app');
  const showPersonal = data?.scopes.includes('person');
  const showShared = data?.scopes.includes('app');
  const totalCount = data?.memories.length ?? 0;
  const showFilter = totalCount >= 4 || Boolean(filter);

  const renderGroup = (title: string, items: StoredMemoryRow[], writable: boolean, note?: string) => (
    <div className="assistant-memory-group">
      <div className="assistant-memory-group-head">
        <h4>{title}</h4>
        <span className="assistant-memory-count">{items.length}</span>
      </div>
      {note && <p className="assistant-memory-note">{note}</p>}
      {items.length === 0 ? (
        <p className="assistant-memory-group-empty">—</p>
      ) : (
        <ul className="assistant-memory-list">
          {items.map((row) => {
            const isEditing = editingId === row.id;
            const dateLabel = formatMemoryDate(row.updatedAt || row.createdAt);
            const whoLabel = row.source === 'assistant' ? say('memorySourceAssistant') : say('memorySourcePerson');
            return (
              <li key={row.id} className="assistant-memory-row">
                {isEditing ? (
                  <div className="assistant-memory-edit">
                    <textarea
                      className="assistant-memory-input"
                      rows={2}
                      autoFocus
                      value={editingText}
                      maxLength={500}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => handleEditKey(e, row)}
                    />
                    <div className="assistant-memory-row-actions">
                      <Button size="xs" variant="primary" disabled={saving || !editingText.trim()} onClick={() => void handleEditSave(row)}>
                        {say('memorySave')}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(null);
                          setEditingText('');
                        }}
                      >
                        {say('memoryCancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="assistant-memory-content">{row.content}</p>
                    <div className="assistant-memory-meta">
                      <span className="assistant-memory-badge">{dateLabel ? `${whoLabel} · ${dateLabel}` : whoLabel}</span>
                      {writable && (
                        <div className="assistant-memory-row-actions">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setEditingId(row.id);
                              setEditingText(row.content);
                            }}
                          >
                            {say('edit')}
                          </Button>
                          <Button size="xs" variant="ghost" disabled={saving} onClick={() => void handleDelete(row.id)}>
                            {say('delete')}
                          </Button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <section className="assistant-memory-drawer" aria-label={say('memoryTitle')}>
      <div className="assistant-memory-head">
        <div className="assistant-memory-head-inner">
          <div>
            <div className="assistant-memory-title-row">
              <h3 className="assistant-memory-title">{say('memoryTitle')}</h3>
              {data && <span className="assistant-memory-quota">{say('memoryQuota', { used: totalCount, max: data.maxItems })}</span>}
            </div>
            <p className="assistant-memory-desc">{say('memoryDescription')}</p>
          </div>
          <Button size="xs" variant="ghost" ariaLabel={say('closeMemory')} onClick={onClose}>
            ×
          </Button>
        </div>
      </div>
      <div className="assistant-memory-body">
        <div className="assistant-memory-body-inner">
          {error && (
            <p className="assistant-memory-error" role="alert">
              {error}
            </p>
          )}
          {canAddAny && (
            <form className="assistant-memory-form" onSubmit={(event) => void handleAdd(event)}>
              <textarea
                className="assistant-memory-input"
                rows={2}
                value={draft}
                maxLength={500}
                placeholder={say('memoryPlaceholder')}
                aria-label={say('memoryAdd')}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleDraftKey}
              />
              <div className="assistant-memory-form-bar">
                {canAddPersonal && canAddShared && (
                  <Select<'person' | 'app'>
                    size="sm"
                    value={draftScope}
                    onValueChange={(next) => {
                      if (next) setDraftScope(next);
                    }}
                    options={[
                      { value: 'person', label: say('memoryPersonal') },
                      { value: 'app', label: say('memoryShared') },
                    ]}
                    ariaLabel={say('memory')}
                  />
                )}
                <Button size="sm" variant="primary" type="submit" disabled={saving || !draft.trim()}>
                  {say('memorySave')}
                </Button>
              </div>
            </form>
          )}
          {showFilter && (
            <input
              type="search"
              className="assistant-memory-filter"
              value={filter}
              placeholder={say('memoryFilterPlaceholder')}
              aria-label={say('memoryFilter')}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          {loading && !data ? (
            <p className="assistant-memory-empty">{say('memoryLoading')}</p>
          ) : data && totalCount === 0 ? (
            <p className="assistant-memory-empty">{say('memoryEmpty')}</p>
          ) : trimmedFilter && visibleMemories.length === 0 ? (
            <p className="assistant-memory-empty">{say('memoryFilterEmpty', { query: filter.trim() })}</p>
          ) : (
            <>
              {showPersonal && renderGroup(say('memoryPersonal'), personalItems, true)}
              {showShared &&
                renderGroup(
                  say('memoryShared'),
                  sharedItems,
                  Boolean(data?.canWriteShared),
                  data && !data.canWriteShared ? say('memoryReadOnlyShared') : undefined,
                )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
