import { useEffect, useId, useRef, useState } from 'react';
import { SUPPORT_WARNING_MS, type SupportSessionView } from '../../shared/tenantSupport.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import './TenantSupport.css';
import { say } from '../copy/tenancy/components/SupportBanner.js';
import { roleName } from '../tenantNames.js';

interface SupportScreenProps {
  session: SupportSessionView;
  /** The browser's own clock at which the session ends (its reply's remainingMs from receipt). */
  deadline: number;
  platformLabel: string;
  /** What the dealer is called, when the server said (tenantNames.ts); its id otherwise. */
  tenantName?: string;
  /** A request (exit, or the return to the platform) is on the wire. */
  busy?: boolean;
  error?: string;
  /** The server said the session is over, whatever the clock says. */
  ended?: boolean;
  onExit: () => void;
  onReturn: () => void;
  now?: () => number;
}

/** Re-render at the next boundary the screen shows: the warning, then the end. */
function useBoundaries(deadline: number, now: () => number) {
  const [, tick] = useState(0);
  useEffect(() => {
    const left = deadline - now();
    const next = left > SUPPORT_WARNING_MS ? left - SUPPORT_WARNING_MS : left > 0 ? left : undefined;
    if (next === undefined) return;
    const timer = setTimeout(() => tick((n) => n + 1), next + 5);
    return () => clearTimeout(timer);
  });
  return deadline - now();
}

/** The session, said where it cannot be missed: the dealer, the role and the
 * end, with Exit. Two minutes before the end it says so, once, politely. */
export function SupportBanner({
  session,
  deadline,
  tenantName,
  busy = false,
  error,
  onExit,
  now = Date.now,
}: Pick<SupportScreenProps, 'session' | 'deadline' | 'tenantName' | 'busy' | 'error' | 'onExit' | 'now'>) {
  const remaining = useBoundaries(deadline, now);
  const warning = remaining > 0 && remaining <= SUPPORT_WARNING_MS;
  return (
    <section className="support-banner" aria-label={say('supportSession')} data-warning={warning || undefined}>
      <span className="support-banner-mark" aria-hidden="true" />
      <p>
        {/* The dealer's own brand is around this banner; this says whose eyes are on it. */}
        <span className="support-banner-label">{say('supportSession')}</span> ·{' '}
        <span className="support-banner-viewing" data-viewing="provider">
          {say('viewingAsProvider')}
        </span>{' '}
        · <bdi>{tenantName ?? session.tenantId}</bdi> {say('as')} <bdi>{roleName(session.dealerRole)}</bdi>
        {say('ends')} <time dateTime={new Date(deadline).toISOString()}>{formatDateTime(deadline)}</time>
      </p>
      {/* On the page before its words, so the warning is heard when it comes. */}
      <p className="support-banner-live" role="status" aria-live="polite">
        {warning ? say('endsInTwoMinutes') : ''}
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="ghost"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onExit();
        }}
      >
        {say('exit')}
      </button>
    </section>
  );
}

/** The whole content under a support lease in this release: the banner, a
 * plain statement that support access is not available yet, and the cover
 * once the session is over. Nothing of the dealer's is shown. */
export function SupportScreen(props: SupportScreenProps) {
  const { session, deadline, platformLabel, tenantName, busy = false, error, ended = false, onReturn, now = Date.now } = props;
  const dealer = tenantName ?? session.tenantId;
  const heading = useId(),
    returning = useRef<HTMLButtonElement>(null);
  const remaining = useBoundaries(deadline, now);
  const over = ended || remaining <= 0;
  return (
    <>
      <SupportBanner {...props} />
      <section className="support-notice" aria-labelledby={heading}>
        <h1 id={heading}>{say('supportAccessIsNotAvailable')}</h1>
        <p>
          {say('you')} <bdi>{dealer}</bdi> {say('as')} <bdi>{roleName(session.dealerRole)}</bdi>
          {say('viewingAndChangingItsRecords')}
        </p>
        <p>
          {say('thisSessionIsRecorded')} <bdi>{session.operatorName}</bdi>
          {say('andYourReason')} <q>{session.reason}</q>
        </p>
        <p>{say('exitToReturn', { platformLabel })}</p>
      </section>
      {over && (
        <Modal className="support-ended" ariaLabel={say('supportSessionEnded')} closeDisabled onClose={() => {}} initialFocus={returning}>
          <h2>{say('supportSessionEnded')}</h2>
          <p>
            {say('yourSession')} <bdi>{dealer}</bdi>{' '}
            {ended ? (
              say('hasEnded')
            ) : (
              <>
                {say('ended')} <time dateTime={new Date(deadline).toISOString()}>{formatDateTime(deadline)}</time>
              </>
            )}
            {say('nothingMoreIsRecorded')}
          </p>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button
              ref={returning}
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onReturn();
              }}
            >
              {say('return', { platformLabel })}
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
