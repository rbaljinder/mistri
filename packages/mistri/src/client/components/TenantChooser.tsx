import { useEffect, useId, useState } from 'react';
import { Modal } from '@mistriwork/ui/Modal.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import { say } from '../copy/tenancy/components/TenantChooser.js';
import { tenancyNoun } from '../tenancyNoun.js';
import { setTenantContextEntry } from '../tenantContextEntry.js';

export interface TenantChooserProps {
  appName: string;
  tenantIds: readonly string[];
  /** What each tenant is called, by id, where the server said (tenantNames.ts): a tenant without one is said by its id. */
  names?: Readonly<Record<string, string>>;
  /** The tenants that are sandboxes (tenantNames.ts): each is marked so wherever it is named. */
  sandboxes?: ReadonlySet<string>;
  /** The platform realm's label, shown for its reserved `@platform` choice. */
  platformLabel?: string;
  /** What the App calls a tenant (`auth.tenancy.label`, "Dealer"), said wherever the chooser would say "tenant". */
  tenantLabel?: string;
  currentTenant?: string;
  requestedTenant?: string;
  busy?: boolean;
  error?: string;
  onSelect: (tenantId: string) => void;
  onRetry?: () => void;
}

const platformName = (label: string | undefined) => label ?? say('platform');
/** The chooser's words, in the App's own name for a tenant when it gives one. */
function wordsFor(label: string | undefined) {
  if (!label) {
    return {
      colon: say('tenantColon'),
      choose: say('chooseATenant'),
      thatOne: say('chooseThatTenantToOpen'),
      none: say('noAvailableTenantsContact'),
      choices: say('availableTenants'),
    };
  }
  const { name, names, vowel } = tenancyNoun(label, label);
  return {
    colon: say('labeledColon', { Name: label }),
    choose: say(vowel ? 'chooseLabeledVowel' : 'chooseLabeled', { name }),
    thatOne: say('chooseThatLabeledToOpen', { name }),
    none: say('noLabeledContact', { names }),
    choices: say('labeledChoices', { names }),
  };
}
/** A tenant as a person reads it: its name, the platform realm by its own label, and the id only when there is no name. */
const nameOf = (tenantId: string, names: Readonly<Record<string, string>> | undefined, platformLabel: string | undefined) =>
  tenantId === PLATFORM_TENANT_ID ? platformName(platformLabel) : (names?.[tenantId] ?? tenantId);
/* A sandbox is a copy, and is said to be one beside its name:
   a warn tone chip, the one mark the bar carries in every look, so work done
   there is never mistaken for the live tenant's. */
function SandboxMark() {
  return <span className="tenant-sandbox-mark tone-warn">{say('sandbox')}</span>;
}
/** "Tenant: North Depot" ("Dealer: …" where the App says so), or the platform realm by its own label: never the reserved id. */
function Current({
  tenantId,
  names,
  sandboxes,
  platformLabel,
  tenantLabel,
}: {
  tenantId: string;
  names?: Readonly<Record<string, string>>;
  sandboxes?: ReadonlySet<string>;
  platformLabel?: string;
  tenantLabel?: string;
}) {
  return tenantId === PLATFORM_TENANT_ID ? (
    <bdi>{platformName(platformLabel)}</bdi>
  ) : (
    <>
      <span className="tenant-control-word">{wordsFor(tenantLabel).colon} </span>
      <bdi>{nameOf(tenantId, names, platformLabel)}</bdi>
      {sandboxes?.has(tenantId) && (
        <>
          {' '}
          <SandboxMark />
        </>
      )}
    </>
  );
}

/** A way out of this context the bar also offers (entering a tenant for support): on a phone,
 * where the bar is one row, it is this dialog's instead. */
export interface TenantControlAction {
  label: string;
  onClick: () => void;
}

/** Presentation only: membership discovery and context acknowledgements belong
 * to the caller. Even a sole tenant requires an explicit choice. */
export function TenantChooser({
  appName,
  tenantIds,
  names,
  sandboxes,
  platformLabel,
  tenantLabel,
  currentTenant,
  requestedTenant,
  busy = false,
  error,
  onSelect,
  onRetry,
}: TenantChooserProps) {
  const heading = useId();
  const words = wordsFor(tenantLabel);
  const named = (tenantId: string) => nameOf(tenantId, names, platformLabel);
  return (
    <section className="tenant-chooser" aria-labelledby={heading}>
      <p className="tenant-chooser-app">{appName}</p>
      <h1 id={heading}>{words.choose}</h1>
      {requestedTenant !== undefined && (
        <p className="tenant-chooser-note">
          {say('thisLinkBelongs')} <bdi>{named(requestedTenant)}</bdi>
          {words.thatOne}
        </p>
      )}
      {currentTenant !== undefined && (
        <p className="tenant-chooser-current">
          <Current tenantId={currentTenant} names={names} sandboxes={sandboxes} platformLabel={platformLabel} tenantLabel={tenantLabel} />
        </p>
      )}
      {busy && (
        <p className="tenant-chooser-note" role="status">
          {say('pleaseWait')}
        </p>
      )}
      {error && (
        <p className="tenant-chooser-error" role="alert">
          {error}
        </p>
      )}
      {!busy && !error && tenantIds.length === 0 && <p className="tenant-chooser-note">{words.none}</p>}
      {tenantIds.length > 0 && (
        <ul className="tenant-chooser-list" aria-label={words.choices} aria-busy={busy}>
          {tenantIds.map((tenantId) => (
            <li key={tenantId}>
              <button
                type="button"
                className="ghost tenant-chooser-choice"
                disabled={busy}
                data-tenant={tenantId}
                aria-current={tenantId === currentTenant ? 'true' : undefined}
                onClick={() => {
                  if (!busy) onSelect(tenantId);
                }}
              >
                <bdi>{named(tenantId)}</bdi>
                {sandboxes?.has(tenantId) && <SandboxMark />}
                {tenantId === currentTenant && <span className="tenant-chooser-current-mark">{say('current')}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button
          type="button"
          className="ghost tenant-chooser-retry"
          disabled={busy}
          onClick={() => {
            if (!busy) onRetry();
          }}
        >
          {say('checkAgain')}
        </button>
      )}
    </section>
  );
}

/** The caller retains authority over switching. A click does not pretend that
 * a context was established, close the dialog, or alter the current label. */
export function TenantControl({ actions = [], ...props }: TenantChooserProps & { actions?: readonly TenantControlAction[] }) {
  const [open, setOpen] = useState(false);
  /* On a phone this control is the account menu's first item (tenantContextEntry.ts): what it says, and its door. */
  const { currentTenant, names, sandboxes, platformLabel, tenantLabel, busy = false } = props;
  useEffect(() => {
    if (currentTenant === undefined) return;
    const said = {
      word: currentTenant === PLATFORM_TENANT_ID ? '' : wordsFor(tenantLabel).colon,
      name: nameOf(currentTenant, names, platformLabel),
      ...(sandboxes?.has(currentTenant) ? { sandbox: say('sandbox') } : {}),
      busy,
      open: () => setOpen(true),
    };
    setTenantContextEntry(said);
    return () => setTenantContextEntry(undefined, said);
  }, [currentTenant, names, sandboxes, platformLabel, tenantLabel, busy]);
  return (
    <span className="tenant-control">
      <button
        type="button"
        className="ghost tenant-control-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => setOpen(true)}
      >
        <span>
          {props.currentTenant === undefined ? (
            wordsFor(props.tenantLabel).choose
          ) : (
            <Current
              tenantId={props.currentTenant}
              names={props.names}
              sandboxes={props.sandboxes}
              platformLabel={props.platformLabel}
              tenantLabel={props.tenantLabel}
            />
          )}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <Modal
          className="tenant-chooser-dialog"
          ariaLabel={wordsFor(props.tenantLabel).choose}
          closeDisabled={props.busy}
          onClose={() => setOpen(false)}
        >
          <TenantChooser {...props} />
          <div className="tenant-chooser-actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="ghost tenant-chooser-elsewhere"
                disabled={props.busy}
                onClick={() => {
                  setOpen(false);
                  action.onClick();
                }}
              >
                {action.label}
              </button>
            ))}
            <button type="button" className="ghost" disabled={props.busy} onClick={() => setOpen(false)}>
              {say('common.close')}
            </button>
          </div>
        </Modal>
      )}
    </span>
  );
}
