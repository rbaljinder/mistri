import type { ReactNode } from 'react';

/* The gallery's own furniture, not part of the system: a section, and a named specimen in it. */
export function Section({ id, title, lede, children }: { id: string; title: string; lede: string; children: ReactNode }) {
  return (
    <section id={id} data-part="section" aria-labelledby={`${id}-title`}>
      <header>
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{lede}</p>
      </header>
      <div data-part="specimens">{children}</div>
    </section>
  );
}

export function Specimen({ name, wide, children }: { name: string; wide?: boolean; children: ReactNode }) {
  return (
    <figure data-part="specimen" data-wide={wide ? '' : undefined}>
      <figcaption>{name}</figcaption>
      <div data-part="stage">{children}</div>
    </figure>
  );
}
