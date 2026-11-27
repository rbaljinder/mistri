/**
 * A member of the team as a command's input asks for one (`field.member()`): the team's names, read through the
 * members' own narrow read (/api/team, server tenantTeamRoute.ts) that `useTeam()` reads for anyone who does not
 * manage the team — a name and the account id a pick is stored by, never an address or a role — so a member who
 * manages nothing still picks a colleague. The value is the account id; whether it is a member is the server's to
 * judge where the command runs (commandMembers.ts), whatever this list held.
 */
import { useEffect, useState } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { captureSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { Dropdown, readsAsName } from '@mistriwork/kit/client/components/Dropdown.js';
import { say } from '../copy/forms/components/MemberPicker.js';

interface Named {
  readonly account: string;
  readonly name: string;
  readonly you: boolean;
}

/* One read of the team per session and tenant: switching tenants or signing in as someone else never shows the last team's names. */
let asked: { readonly owner: string; readonly read: Promise<readonly Named[] | null> } | undefined;

function ownerKey(): string {
  const owner = captureSessionIdentity();
  return `${owner.epoch}\n${owner.accountId ?? ''}\n${owner.tenant?.tenantId ?? ''}`;
}

/** The team's names, or null where the App keeps no such read (no tenant, `auth.tenancy.team: false`) or it failed. */
function readTeamNames(owner: string): Promise<readonly Named[] | null> {
  if (asked?.owner !== owner) {
    let entry: typeof asked;
    const read = (async () => {
      try {
        const rows = ((await api('/api/team', {})) as { members?: unknown } | null)?.members;
        if (!Array.isArray(rows)) {
          if (asked === entry) asked = undefined;
          return null;
        }
        return rows.flatMap((row: { account?: unknown; name?: unknown; you?: unknown }) =>
          typeof row?.account === 'string'
            ? [
                {
                  account: row.account,
                  name: typeof row.name === 'string' ? row.name : '',
                  you: row.you === true,
                },
              ]
            : [],
        );
      } catch {
        if (asked === entry) asked = undefined;
        return null;
      }
    })();
    entry = asked = { owner, read };
  }
  return asked.read;
}

/** Test-only: forget the page's read. */
export function forgetTeamNames(): void {
  asked = undefined;
}

export function MemberPicker({
  id,
  label,
  value,
  optional,
  invalid,
  describedBy,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  optional?: boolean;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const owner = ownerKey();
  const [team, setTeam] = useState<readonly Named[] | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    setTeam(undefined);
    void readTeamNames(owner).then((read) => {
      if (current) setTeam(read);
    });
    return () => {
      current = false;
    };
  }, [owner]);
  const people = team ?? [];
  const chosen = typeof value === 'string' ? value : '';
  /* A pick the list does not hold (a starting value, someone since gone) is still said, by its id, until changed. */
  const items = [
    ...(chosen && !people.some((person) => person.account === chosen) ? [{ value: chosen, label: chosen }] : []),
    ...people.map((person) => ({
      value: person.account,
      label: person.you ? say('memberYou', { name: person.name || say('memberUnnamed') }) : person.name || say('memberUnnamed'),
    })),
  ];
  const emptyLabel =
    team === null
      ? say('noTeamToList')
      : chosen && optional
        ? say('memberNone')
        : readsAsName(label)
          ? say('choosePlaceholder', { label: label.toLowerCase() })
          : say('chooseOne');
  return (
    <Dropdown
      id={id}
      ariaLabelledBy={`${id}-label`}
      ariaInvalid={invalid}
      ariaDescribedBy={describedBy}
      disabled={disabled || team === null}
      value={chosen}
      valueClassName={chosen ? undefined : 'is-empty'}
      items={[...(chosen && !optional ? [] : [{ value: '', label: emptyLabel }]), ...items]}
      onValueChange={(next) => {
        if (next !== '' || optional) onChange(next);
      }}
    />
  );
}
