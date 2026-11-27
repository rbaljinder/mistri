import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AiAssistantPanel, AiAssistantSurface, AiModeSwitcher, AiReasoning } from '../views.js';

afterEach(cleanup);

describe('AiReasoning', () => {
  test('renders collapsed by default, expands to show trace, and auto-collapses after streaming completes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AiReasoning text="Checking lead stage..." streaming defaultOpen autoCollapse />);
    const trigger = screen.getByRole('button', { name: /Thinking/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Checking lead stage...')).toBeVisible();

    rerender(<AiReasoning text="Checking lead stage... done." streaming={false} durationMs={2400} defaultOpen autoCollapse />);
    expect(screen.getByRole('button', { name: 'Thought for 2.4s' })).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Thought for 2.4s' }));
    expect(screen.getByRole('button', { name: 'Thought for 2.4s' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('renders a quiet non-expandable note when reasoning is redacted', () => {
    render(<AiReasoning redacted durationMs={1200} />);
    expect(screen.getByText('Reasoning hidden by model provider.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('AiAssistantSurface', () => {
  test('sidebar mode renders non-modal beside drawer without backdrop scrim and supports keyboard resize', async () => {
    const user = userEvent.setup();
    const onWidthChange = vi.fn();
    render(
      <AiAssistantSurface open presentation="sidebar" ariaLabel="Assistant" onWidthChange={onWidthChange}>
        <div>Panel body</div>
      </AiAssistantSurface>,
    );
    const surface = screen.getByRole('complementary', { name: 'Assistant' });
    expect(surface).toHaveAttribute('data-beside', '');
    expect(surface).toHaveAttribute('data-docked', '');
    expect(document.querySelector('[data-slot="drawer-backdrop"]')).toBeNull();
    expect(within(surface).getByText('Panel body')).toBeInTheDocument();

    const handle = within(surface).getByRole('separator', { name: 'Resize assistant' });
    handle.focus();
    await user.keyboard('{ArrowLeft}');
    expect(onWidthChange).toHaveBeenCalledWith(536);
  });

  test('floating mode renders non-modal corner window and fullscreen steps back on Escape before closing', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onPresentationChange = vi.fn();
    const { rerender } = render(
      <AiAssistantSurface
        open
        presentation="floating"
        floatingPosition="bottom-right"
        ariaLabel="Assistant"
        onOpenChange={onOpenChange}
        onPresentationChange={onPresentationChange}
      >
        <button type="button">Inside</button>
      </AiAssistantSurface>,
    );
    const floating = screen.getByRole('complementary', { name: 'Assistant' });
    expect(floating).toHaveAttribute('data-mode', 'floating');
    expect(floating).toHaveAttribute('data-position', 'bottom-right');

    rerender(
      <AiAssistantSurface
        open
        presentation="fullscreen"
        fullscreenLeft={240}
        ariaLabel="Assistant"
        onOpenChange={onOpenChange}
        onPresentationChange={onPresentationChange}
      >
        <button type="button">Inside</button>
      </AiAssistantSurface>,
    );
    const full = screen.getByRole('complementary', { name: 'Assistant' });
    expect(full).toHaveAttribute('data-mode', 'fullscreen');
    expect(full).toHaveAttribute('data-bounded', '');

    screen.getByRole('button', { name: 'Inside' }).focus();
    await user.keyboard('{Escape}');
    expect(onPresentationChange).toHaveBeenCalledWith('floating');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('page mode renders a full-page split workspace with Resizable rail and main pane', () => {
    render(
      <AiAssistantSurface presentation="page" ariaLabel="Assistant" rail={<div>Thread list</div>}>
        <div>Active thread</div>
      </AiAssistantSurface>,
    );
    const page = screen.getByRole('region', { name: 'Assistant' });
    expect(page).toHaveAttribute('data-mode', 'page');
    expect(within(page).getByText('Thread list')).toBeInTheDocument();
    expect(within(page).getByText('Active thread')).toBeInTheDocument();
    expect(within(page).getByRole('separator')).toBeInTheDocument();
  });

  test('floating mode supports keyboard resize and Alt+Backspace reset', async () => {
    const user = userEvent.setup();
    render(
      <AiAssistantSurface open presentation="floating" ariaLabel="Assistant">
        <div>Floating body</div>
      </AiAssistantSurface>,
    );
    const surface = screen.getByRole('complementary', { name: 'Assistant' });
    const handle = within(surface).getByRole('separator', { name: 'Resize assistant' });
    handle.focus();
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(surface.style.getPropertyValue('--ai-float-width')).toBe('472px');
    expect(surface.style.getPropertyValue('--ai-float-height')).toBe('632px');
    await user.keyboard('{Alt>}{Backspace}{/Alt}');
    expect(surface.style.getPropertyValue('--ai-float-width')).toBe('');
  });
});

describe('AiAssistantPanel reasoning, blocks, and mode switcher', () => {
  test('renders reasoning traces, generative UI blocks, and mode switcher controls', async () => {
    const user = userEvent.setup();
    const onPresentationChange = vi.fn();
    const onOpenPage = vi.fn();
    render(
      <AiAssistantPanel
        presentation="sidebar"
        onPresentationChange={onPresentationChange}
        onOpenPage={onOpenPage}
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: 'Here are the open deals.',
            reasoning: { id: 'r1', text: 'Querying open opportunities sorted by value.', durationMs: 1500 },
            blocks: [
              { id: 'b1', kind: 'metric', title: 'Pipeline', payload: { total: '$42k' } },
              { id: 'b2', kind: 'table', status: 'loading' },
            ],
          },
        ]}
        renderBlock={(block, ctx) => (
          <div data-testid="custom-block">
            {block.title} ({ctx.presentation})
          </div>
        )}
      />,
    );

    expect(screen.getByRole('button', { name: 'Thought for 1.5s' })).toBeInTheDocument();
    expect(screen.getByTestId('custom-block')).toHaveTextContent('Pipeline (sidebar)');

    await user.click(screen.getByRole('button', { name: 'Floating window' }));
    expect(onPresentationChange).toHaveBeenCalledWith('floating');

    await user.click(screen.getByRole('button', { name: 'Open full page' }));
    expect(onOpenPage).toHaveBeenCalled();
  });

  test('AiModeSwitcher toggles fullscreen back to restoreMode', async () => {
    const user = userEvent.setup();
    const onPresentationChange = vi.fn();
    render(<AiModeSwitcher presentation="fullscreen" restoreMode="floating" onPresentationChange={onPresentationChange} />);
    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(onPresentationChange).toHaveBeenCalledWith('floating');
  });
});
