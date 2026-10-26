/* A board or a split is a key of the list view (`board: { by }`, `split: { detail }`), written in these tests as the
   presentation object they exercise: the key it says, and the options it holds. */
export function keyedPresentation<V extends Record<string, unknown>>(view: V): Record<string, unknown> {
  const { presentation, ...rest } = view;
  const card = presentation as { kind?: unknown } | undefined;
  if (card && (card.kind === 'board' || card.kind === 'split')) {
    const { kind, ...options } = card;
    return { ...rest, [kind as string]: options };
  }
  return view;
}
