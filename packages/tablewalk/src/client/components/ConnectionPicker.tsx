/**
 * The database picker in the top bar: which connection is open, the others
 * a click away, re-introspection as the one action, and the cog beside it
 * that opens Connections — a destination, not a variation on the thing
 * above it.
 */
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { say } from '../copy/workbench/components/ConnectionPicker.js';

interface PickerConnection {
  id: string;
  name: string;
  detail?: string;
  dialect?: string;
  error?: string;
  connected?: boolean;
}

export function ConnectionPicker({
  connections,
  active,
  onSelect,
  onReintrospect,
  onManage,
}: {
  connections: PickerConnection[];
  active: string;
  onSelect: (id: string) => void;
  onReintrospect: () => void;
  onManage: () => void;
}) {
  return (
    <>
      <Dropdown
        ariaLabel={say('databaseConnection')}
        value={active}
        /* The detail is the redacted form — host and database, never a password — as a second line rather than a tooltip, because it is what tells two connections called "app" apart. */
        items={connections.map((conn) => ({
          value: conn.id,
          label: conn.name,
          detail: conn.error ? say('unreachableDetail', { detail: conn.detail ?? '' }) : conn.detail,
          badge: conn.dialect,
          tone: conn.error ? 'bad' : undefined,
        }))}
        onChange={onSelect}
        /* Re-introspection on demand: the schema is read once and trusted, which is wrong the moment a migration runs in another window. */
        actions={[{ label: say('reReadTheSchema'), onSelect: onReintrospect }]}
      />
      <button
        type="button"
        className="conn-manage"
        title={say('manageConnections')}
        aria-label={say('manageConnections')}
        onClick={onManage}
      >
        {/* A cog with teeth, not a circle with spokes: the first draft read as a brightness control. */}
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </>
  );
}
