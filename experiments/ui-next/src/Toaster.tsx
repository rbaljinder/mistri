import { Toast, ToastAction, ToastClose, ToastDescription, ToastRegion, ToastTitle } from '@ui-sdk/react/toast';
import { words } from './words';

export function Toaster() {
  return (
    <ToastRegion>
      {(item) => (
        <Toast>
          <ToastTitle />
          <ToastDescription />
          {/* What was just done can be taken back from where it was said: `toast(…, { action: { label: 'Undo', … } })`. */}
          {item.action && <ToastAction />}
          <ToastClose aria-label={words.dismiss} />
        </Toast>
      )}
    </ToastRegion>
  );
}
