import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ButtonLink } from '../Button.js';
import { MediaCard, StatCard } from '../primitives/display.js';
import { safeHref } from './safeHref.js';

describe('safeHref protocol sanitizer', () => {
  test('allows safe relative, fragment, query, https, http, mailto, tel, and blob URLs', () => {
    for (const url of [
      '/items/42',
      'items/42',
      '#details',
      '?q=camera',
      '/items/foo:bar',
      'https://example.com/path',
      'http://localhost:3000/test',
      'mailto:hello@example.com',
      'tel:+15551234567',
      'blob:https://example.com/uuid',
    ]) {
      expect(safeHref(url)).toBe(url);
    }
  });

  test('blocks javascript:, vbscript:, data:, and whitespace/control-obfuscated dangerous schemes', () => {
    for (const url of [
      'javascript:alert(1)',
      '  JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      '',
      '   ',
    ]) {
      expect(safeHref(url)).toBeUndefined();
    }
  });

  test('ButtonLink, MediaCard, and StatCard never render javascript: hrefs', () => {
    render(
      <div>
        <ButtonLink href="javascript:alert(1)">Bad Button</ButtonLink>
        <MediaCard title="Lamp" href="javascript:alert(1)" />
        <StatCard label="Revenue" value="$100" href="vbscript:msgbox(1)" />
      </div>,
    );
    const badButton = screen.getByText('Bad Button').closest('a');
    expect(badButton?.getAttribute('href')).toBeNull();
    expect(screen.getByText('Lamp').closest('a')).toBeNull();
    expect(screen.getByText('Revenue').closest('a')).toBeNull();
  });
});
