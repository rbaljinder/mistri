/**
 * A member of the team as a command's input asks for one (`field.member()`): the team's names, read through the
 * members' own narrow read (/api/team, server tenantTeamRoute.ts) that `useTeam()` reads for anyone who does not
 * manage the team — a name and the account id a pick is stored by, never an address or a role — so a member who
 * manages nothing still picks a colleague. The value is the account id; whether it is a member is the server's to
 * judge where the command runs (commandMembers.ts), whatever this list held.
 */
import { useEffect, useState } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { Dropdown, readsAsName } from '@mistriwork/kit/client/components/Dropdown.js';
import { say } from '../copy/forms/components/MemberPicker.js';

interface Named {
  readonly account: string;
  readonly name: string;
  readonly you: boolean;
}

/* One read of the team a page: every member field of every form opened on it lists the same people. */
let asked: Promise<readonly Named[] | null> | undefined;

/** The team's names, or null where the App keeps no such read (no tenant, `auth.tenancy.team: false`) or it failed. */
function readTeamNames(): Promise<readonly Named[] | null> {
  asked ??= (async () => {
    try {
      const rows = ((await api('/api/team', {})) as { members?: unknown } | null)?.members;
      if (!Array.isArray(rows)) return null;
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
      asked = undefined;
      return null;
    }
  })();
  return asked;
}

/** Test-only: forget the page's read. */
export function forgetTeamNames(): void {
  asked = undefined;
}

export function MemberPicker({
  id,
  label,
  value,
  invalid,
  describedBy,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [team, setTeam] = useState<readonly Named[] | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void readTeamNames().then((read) => {
      if (current) setTeam(read);
    });
    return () => {
      current = false;
    };
  }, []);
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
  return (
    <Dropdown
      id={id}
      ariaLabelledBy={`${id}-label`}
      ariaInvalid={invalid}
      ariaDescribedBy={describedBy}
      disabled={disabled || team === null}
      value={chosen}
      valueClassName={chosen ? undefined : 'is-empty'}
      items={[
        ...(chosen
          ? []
          : [
              {
                value: '',
                label:
                  team === null
                    ? say('noTeamToList')
                    : readsAsName(label)
                      ? say('choosePlaceholder', { label: label.toLowerCase() })
                      : say('chooseOne'),
              },
            ]),
        ...items,
      ]}
      onValueChange={(next) => {
        if (next !== '') onChange(next);
      }}
    />
  );
}
