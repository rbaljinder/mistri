/**
 * Mounts an author-declared interactive custom assistant block (`assistant.customBlocks[name].component`)
 * inside Mistri's standard component sandbox: on-demand compiled module loading (`loadComponent`),
 * `ErrorBoundary`, `UiSurfaceSeamContext`, `ComponentStyleScope`, and `UiSizeContext`.
 */
import { ComponentStyleScope, UiSurfaceSeamContext } from '@mistriwork/ui';
import { useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { ErrorBoundary } from '@mistriwork/kit/client/components/ErrorBoundary.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { COMPACT_BELOW, UiSizeContext, type UiSize } from './context.js';
import { loadComponent } from './componentLoader.js';
import { useComponentKey } from './componentKey.js';
import { mistriSurfaceSeam } from './seam.js';

interface AssistantCustomBlockComponentProps {
  readonly name: string;
  readonly title?: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly streaming: boolean;
  readonly presentation: 'inline' | 'canvas';
  readonly sendMessage: (text: string) => void;
  readonly navigate: (address: string) => void;
  readonly openCanvas: () => void;
}

const parts = new Map<string, ComponentType<AssistantCustomBlockComponentProps>>();
function partFor(id: string, key: string): ComponentType<AssistantCustomBlockComponentProps> {
  let part = parts.get(key);
  if (!part) {
    part = onDemand(
      () => loadComponent(id).then((component) => ({ component: component as ComponentType<AssistantCustomBlockComponentProps> })),
      'component',
    );
    parts.set(key, part);
  }
  return part;
}

export function AssistantCustomBlock({ componentId, given }: { componentId: string; given: AssistantCustomBlockComponentProps }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<UiSize>({ width: 640, compact: false });
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const width = node.clientWidth;
      setSize((before) => (before.width === width ? before : { width, compact: width < COMPACT_BELOW }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const Part = partFor(componentId, useComponentKey(componentId));
  return (
    <div className="assistant-custom-host" data-component={componentId} ref={box}>
      <ErrorBoundary>
        <UiSurfaceSeamContext.Provider value={mistriSurfaceSeam}>
          <ComponentStyleScope.Provider value={componentId}>
            <UiSizeContext.Provider value={size}>
              <Part {...given} />
            </UiSizeContext.Provider>
          </ComponentStyleScope.Provider>
        </UiSurfaceSeamContext.Provider>
      </ErrorBoundary>
    </div>
  );
}
