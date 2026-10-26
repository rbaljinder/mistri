import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WorkflowStatus } from './WorkflowStatus.js';

const definition = {
  field: 'status',
  steps: [
    { value: 'new', label: 'New' },
    { value: 'active', label: 'Active' },
    { value: 'closed', label: 'Closed' },
  ],
};
describe('workflow status', () => {
  it('marks only the current state without inventing completion history or actions', () => {
    const { container } = render(<WorkflowStatus definition={definition} value="active" />);
    expect(screen.getByRole('list', { name: 'Workflow status' })).toBeTruthy();
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('Active');
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('passes nothing unless the author says the steps are an order', () => {
    const { container, rerender } = render(<WorkflowStatus definition={definition} value="closed" />);
    expect(container.querySelectorAll('[data-passed]')).toHaveLength(0);
    rerender(<WorkflowStatus definition={{ ...definition, ordered: true }} value="closed" />);
    const passed = [...container.querySelectorAll('[data-passed]')];
    expect(passed.map((step) => step.textContent)).toEqual(['New (passed)', 'Active (passed)']);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('Closed');
    // A state off the path says nothing about the path.
    rerender(<WorkflowStatus definition={{ ...definition, ordered: true }} value="canceled" />);
    expect(container.querySelectorAll('[data-passed]')).toHaveLength(0);
    rerender(<WorkflowStatus definition={{ ...definition, ordered: true }} value="new" />);
    expect(container.querySelectorAll('[data-passed]')).toHaveLength(0);
  });
  it('marks the steps the record can move to now, never the current one', () => {
    const { container } = render(<WorkflowStatus definition={definition} value="active" reachable={new Set(['closed', 'active'])} />);
    expect([...container.querySelectorAll('[data-reachable]')].map((step) => step.textContent)).toEqual(['Closed (available from here)']);
    expect(container.querySelector('[aria-current="step"]')?.hasAttribute('data-reachable')).toBe(false);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows unmapped and empty states explicitly', () => {
    const { rerender, container } = render(<WorkflowStatus definition={definition} value="canceled" />);
    expect(screen.getByRole('status').textContent).toContain('Canceled');
    expect(container.querySelector('[aria-current]')).toBeNull();
    rerender(<WorkflowStatus definition={definition} value={null} />);
    expect(screen.getByRole('status').textContent).toContain('Not set');
  });
});
