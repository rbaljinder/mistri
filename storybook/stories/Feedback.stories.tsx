import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { showToast } from '../../packages/kit/src/client/toast.js';
import { Lightbox } from '../../packages/kit/src/client/components/Lightbox.js';
import { PrefsDialog } from '../../packages/kit/src/client/components/Prefs.js';
import { photo } from './photos.js';

/* What answers a reader: the toast in each of its tones, the photo viewer
   and the preferences dialog, each open as the App opens it. */
const meta = { title: 'Feedback/Surfaces' } satisfies Meta;
export default meta;

/* One toast host per story, with the two live regions it speaks through,
   as index.html gives the App: a toast box is shown and hidden, so it is
   never itself the region a screen reader listens to. */
function Toast({ message, tone, action }: { message: string; tone: string; action?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) showToast(box.current, message, tone, action ? { label: action, run: () => {} } : undefined, true);
  }, [message, tone, action]);
  return (
    <>
      <div ref={box} className="toast" data-live="story-toast-live" data-alert="story-toast-alert" hidden />
      <div className="visually-hidden" id="story-toast-live" role="status" aria-atomic="true" />
      <div className="visually-hidden" id="story-toast-alert" role="alert" aria-atomic="true" />
    </>
  );
}
export const ToastSaved: StoryObj = { render: () => <Toast message="Saved." tone="ok" /> };
/* The Undo a change offers, held a little longer than a plain notice. */
export const ToastWithUndo: StoryObj = {
  render: () => <Toast message="Moved “Confirm the onboarding plan” to Done." tone="ok" action="Undo" />,
};
/* An error stays until it is dismissed, and interrupts rather than waits its turn. */
export const ToastError: StoryObj = {
  render: () => <Toast message="The task could not be saved: the due date is before the start date." tone="error" />,
};

export const PhotoViewer: StoryObj = {
  render: function Open() {
    const [open, setOpen] = useState(true);
    const images = [0, 1, 2].map((i) => ({
      src: photo(`car-${i}`),
      alt: `Photo ${i + 1} of the 2021 Toyota Corolla`,
      caption: ['Three-quarter view', 'Side', 'Rear quarter'][i],
    }));
    return open ? (
      <Lightbox images={images} start={0} label="Photos of 2021 Toyota Corolla" onClose={() => setOpen(false)} />
    ) : (
      <button onClick={() => setOpen(true)}>Open photos</button>
    );
  },
};

export const Preferences: StoryObj = {
  render: function Open() {
    const [open, setOpen] = useState(true);
    return open ? <PrefsDialog onClose={() => setOpen(false)} /> : <button onClick={() => setOpen(true)}>Preferences</button>;
  },
};
