/**
 * The agent console: the MCP tools, driven by hand. Answers are exactly
 * what an agent receives — same code path, stats and all — which is how
 * a tool's description and its shape get tuned.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, state, toast, trapFocus } from '@mistriwork/kit/client/core.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/workbench/components/AgentConsole.js';
import { shown } from '@mistriwork/kit/client/addressMount.js';
import { addHostListener, navFollow, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

interface Spec {
  type?: string | string[];
  description?: string;
}
export interface Tool {
  name: string;
  description?: string;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema?: { properties?: Record<string, Spec>; required?: string[] };
}
interface Answer {
  isError?: boolean;
  structuredContent?: Record<string, unknown> & { stats?: Record<string, unknown> };
  content?: Array<{ text?: string }>;
}
interface Call {
  tool: string;
  args: Record<string, unknown>;
  answer: Answer;
}

/** ~4 characters per token is the rule of thumb the readout says it is. */
const cost = (text: string) => say('charsTokens', { chars: formatNumber(text.length), tokens: formatNumber(Math.ceil(text.length / 4)) });
const typesOf = (spec: Spec) => (Array.isArray(spec.type) ? spec.type : [spec.type]);

function Badges({ tool }: { tool: Tool }) {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint) return <span className="agent-badge tone-ok">{say('readOnly')}</span>;
  return (
    <>
      <span className="agent-badge tone-warn">{say('writes')}</span>
      {a.destructiveHint ? <span className="agent-badge tone-bad">{say('destructive')}</span> : null}
    </>
  );
}

export function AgentConsole({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const tools = useQuery<Tool[]>({
    queryKey: ['agent-tools'],
    queryFn: async () => (await api('/api/agent/tools')).tools ?? [],
    retry: false,
    staleTime: Infinity,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Call[]>([]);
  const [answer, setAnswer] = useState<
    { kind: 'idle' } | { kind: 'running'; tool: string } | { kind: 'error'; message: string } | { kind: 'answer'; answer: Answer }
  >({ kind: 'idle' });
  useEffect(() => {
    const release = trapFocus(panel.current!.parentElement ?? panel.current!) as (() => void) | undefined;
    return () => release?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      e.preventDefault();
      onClose();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);
  useEffect(() => {
    if (tools.isError) {
      toast((tools.error as Error).message, 'error');
      onClose();
    }
  }, [tools.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tools.data)
    return (
      <div className="conn-inner" ref={panel}>
        <p className="loading">{say('readingTheTools')}</p>
      </div>
    );
  const list = tools.data;
  const tool = list.find((t) => t.name === selected) ?? list[0];
  const pick = (name: string) => {
    setSelected(name);
    setAnswer({ kind: 'idle' });
  };
  const call = async (args: Record<string, unknown>) => {
    setAnswer({ kind: 'running', tool: tool.name });
    let got: Answer;
    try {
      got = await api('/api/agent/call', { name: tool.name, arguments: args });
    } catch (err) {
      setAnswer({ kind: 'error', message: (err as Error).message });
      return;
    }
    setTranscript((was) => [{ tool: tool.name, args, answer: got }, ...was]);
    setAnswer({ kind: 'answer', answer: got });
  };
  return (
    <div className="conn-inner" ref={panel}>
      <div className="conn-head">
        <div className="conn-head-titles">
          <div className="conn-brand" aria-hidden="true">
            <span className="brand-mark" />
            <span className="conn-brand-name">tablewalk</span>
          </div>
          <h2>{say('agentConsole')}</h2>
          <p className="conn-lede">{say('theMcpToolsDriven')}</p>
        </div>
        <div className="conn-head-actions">
          <button type="button" onClick={onClose}>
            {say('common.done')}
          </button>
        </div>
      </div>
      <div className="agent-body">
        <div className="agent-tools" role="listbox" aria-label={say('tools')}>
          {list.map((t) => (
            <button
              key={t.name}
              type="button"
              className={`agent-tool${t.name === tool?.name ? ' active' : ''}`}
              role="option"
              aria-selected={t.name === tool?.name}
              onClick={() => pick(t.name)}
            >
              <span className="agent-tool-name">{t.name}</span>
              <span className="agent-tool-badges">
                <Badges tool={t} />
              </span>
            </button>
          ))}
        </div>
        <div className="agent-main">
          {tool ? (
            <>
              <ToolForm key={tool.name} tool={tool} onCall={call} onBadJson={(message) => setAnswer({ kind: 'error', message })} />
              <div className="agent-result">
                {answer.kind === 'running' ? (
                  <p className="loading">{say('calling', { tool: answer.tool })}</p>
                ) : answer.kind === 'error' ? (
                  <p className="agent-error" role="alert">
                    {answer.message}
                  </p>
                ) : answer.kind === 'answer' ? (
                  <AnswerView answer={answer.answer} onClose={onClose} />
                ) : null}
              </div>
              <Transcript calls={transcript} onShow={(a) => setAnswer({ kind: 'answer', answer: a })} />
            </>
          ) : (
            <p className="note">{say('noToolsIsTheServer')}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolForm({
  tool,
  onCall,
  onBadJson,
}: {
  tool: Tool;
  onCall: (args: Record<string, unknown>) => void;
  onBadJson: (message: string) => void;
}) {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const run = () => {
    const args: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(properties)) {
      const raw = (values[name] ?? '').trim();
      if (!raw) continue;
      const types = typesOf(spec);
      if (types.includes('object')) {
        /* Objects arrive as JSON, because a key or a set of values is a shape the caller composes. */
        try {
          args[name] = JSON.parse(raw);
        } catch {
          onBadJson(say('isNotJson', { name, raw: raw.slice(0, 60) }));
          return;
        }
      } else if (types.includes('number') && !Number.isNaN(Number(raw))) {
        args[name] = Number(raw);
      } else if (spec.type === 'boolean') {
        args[name] = raw === 'true' || raw === '1' || raw === 'yes';
      } else {
        args[name] = raw;
      }
    }
    onCall(args);
  };
  return (
    <div className="agent-form">
      <div className="agent-desc-row">
        <h3>{tool.annotations?.title ?? tool.name}</h3>
        <Badges tool={tool} />
      </div>
      {/* The description, shown whole: this text is the tool's entire pitch to a model deciding whether to call it. */}
      <p className="agent-desc">{tool.description}</p>
      {Object.entries(properties).map(([name, spec]) => {
        const isObject = typesOf(spec).includes('object');
        const set = (v: string) => setValues((was) => ({ ...was, [name]: v }));
        return (
          <div key={name} className="agent-field">
            <label>
              {name}
              {required.has(name) ? <span className="req">{say('required')}</span> : null}
            </label>
            {isObject ? (
              <textarea
                className="agent-input agent-json"
                rows={2}
                spellCheck={false}
                placeholder={spec.description ?? '{ }'}
                aria-label={`${name} (json)`}
                value={values[name] ?? ''}
                onChange={(e) => set(e.currentTarget.value)}
              />
            ) : (
              <input
                type="text"
                className="agent-input"
                autoComplete="off"
                spellCheck={false}
                aria-label={name}
                placeholder={
                  name === 'connection'
                    ? `${(state as { activeConnection?: string }).activeConnection ?? 'active'} (active)`
                    : (spec.description ?? '')
                }
                value={values[name] ?? ''}
                onChange={(e) => set(e.currentTarget.value)}
              />
            )}
          </div>
        );
      })}
      <div className="agent-run-row">
        <button type="button" className="primary" onClick={run}>
          {say('callTool')}
        </button>
      </div>
    </div>
  );
}

function AnswerView({ answer, onClose }: { answer: Answer; onClose: () => void }) {
  const text = answer.structuredContent ? JSON.stringify(answer.structuredContent, null, 2) : (answer.content?.[0]?.text ?? '');
  const stats = answer.structuredContent?.stats ?? {};
  /* Every deep link in the answer, surfaced as a real door: "see that row" should cost one click. */
  const links: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string' && /^[#/]\/?\w/.test(value) && !value.startsWith('//')) links.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(answer.structuredContent ?? {});
  return (
    <>
      <div className="agent-stats">
        {answer.isError ? <span className="agent-badge tone-bad">isError</span> : null}
        {Object.entries(stats).map(([k, v]) => (
          <span key={k} className="stat">{`${k} ${v}`}</span>
        ))}
        <span className="stat">{cost(text)}</span>
      </div>
      <pre className={`agent-answer${answer.isError ? ' agent-answer-error' : ''}`}>{text}</pre>
      {links.length ? (
        <div className="agent-links">
          {links.slice(0, 8).map((hash) => (
            <button
              key={hash}
              type="button"
              className="ghost"
              onClick={() => {
                onClose();
                /* A path is navigated, not assigned to `location.hash`; pushState so the console's own history entry survives. */
                navFollow(shown(hash.replace(/^#/, '')));
              }}
            >
              {say('openLink', { link: decodeURIComponent(hash).slice(0, 60) })}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Transcript({ calls, onShow }: { calls: Call[]; onShow: (answer: Answer) => void }) {
  if (!calls.length) return <div />;
  const rows = calls.reduce((n, e) => n + (Number(e.answer.structuredContent?.stats?.rowsRead) || 0), 0);
  return (
    <div className="agent-transcript">
      <h4>{say('thisSessionRead', { calls: say('calls', { count: calls.length }), rows: say('rows', { count: rows }) })}</h4>
      {calls.slice(0, 12).map((entry, i) => {
        const size = entry.answer.content?.[0]?.text?.length ?? 0;
        return (
          <button key={i} type="button" className="agent-past" onClick={() => onShow(entry.answer)}>
            <span className="agent-past-tool">{entry.tool}</span>
            <span className="agent-past-args">{JSON.stringify(entry.args).slice(0, 60)}</span>
            <span className="agent-past-cost">
              {say('callCost', { ms: String(entry.answer.structuredContent?.stats?.ms ?? '–'), size: formatNumber(size) })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
