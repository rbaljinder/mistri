/**
 * The test double: a model whose turns are written as data. Each turn names
 * the person's words it answers (a pattern) and its steps — text to say, and
 * tool calls to make — so a node, component or browser test drives the whole
 * loop, tools and proposals included, offline and the same every run.
 *
 * `$record` in a tool input is the open record's key, read from the context
 * line the turn puts in the person's message, so one script serves any record.
 */
import type { AssistantModel, ModelBlock, ModelMessage } from './assistantModel.js';
import { ACTED_MARK } from './assistantTurn.js';

interface ScriptStep {
  text?: string;
  tools?: Array<{ name: string; input: unknown }>;
}
export interface AssistantScript {
  turns: Array<{ when: string; steps: ScriptStep[] }>;
  /** Said when no turn's pattern matches. */
  otherwise?: string;
}

const personText = (message: ModelMessage): string | undefined => {
  if (message.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  if (message.content.some((block) => block.type === 'tool_result')) return undefined;
  /* What the person did from a card (assistantTurn.ts `actedText`) shares their message; it is not their words. */
  const words = message.content.filter((block) => block.type === 'text' && !String(block.text).startsWith(ACTED_MARK));
  return words.length ? words.map((block) => String(block.text)).join('\n') : undefined;
};

const filled = (value: unknown, record: string | undefined): unknown => {
  if (typeof value === 'string') {
    if (value === '$record' && record !== undefined) return /^\d+$/.test(record) ? Number(record) : record;
    return record === undefined ? value : value.replaceAll('$record', record);
  }
  if (Array.isArray(value)) return value.map((each) => filled(each, record));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, filled(v, record)]));
  return value;
};

const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

export function scriptedModel(script: AssistantScript): AssistantModel {
  return {
    async stream(request, onText, signal) {
      const messages = request.messages;
      let at = messages.length - 1;
      while (at >= 0 && personText(messages[at]) === undefined) at--;
      const said = at >= 0 ? personText(messages[at])! : '';
      const step = messages.slice(at + 1).filter((message) => message.role === 'assistant').length;
      const turn = script.turns.find((each) => new RegExp(each.when, 'i').test(said));
      const record = /Open record: [^/\s]+\/(\S+)/.exec(said)?.[1];
      const planned: ScriptStep = turn
        ? (turn.steps[step] ?? { text: '' })
        : { text: step ? '' : (script.otherwise ?? 'I have no answer scripted for that.') };
      const content: ModelBlock[] = [];
      if (planned.text) {
        // Said in pieces, so the stream is exercised as a real one is.
        for (const piece of planned.text.match(/\S+\s*/g) ?? []) {
          if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          onText(piece);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        content.push({ type: 'text', text: planned.text });
      }
      for (const [i, tool] of (planned.tools ?? []).entries()) {
        content.push({ type: 'tool_use', id: `toolu_script_${messages.length}_${i}`, name: tool.name, input: filled(tool.input, record) });
      }
      return {
        content,
        stopReason: planned.tools?.length ? 'tool_use' : 'end_turn',
        usage: {
          input: tokens(request.system) + tokens(request.tools) + tokens(messages),
          output: tokens(content),
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
    },
  };
}
