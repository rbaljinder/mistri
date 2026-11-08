import { once } from 'node:events';
import { createServer, type Server } from 'node:net';

/* A loopback port that stays bound from the moment it is chosen until a real server takes the same listening handle.
   Reserving by listening on 0, closing and listening again leaves a gap in which a parallel test file can take the
   port; handing the open handle over leaves none. */
export interface HeldPort {
  readonly port: number;
  /** Listen `server` on the held handle and wait until it does; the port is never unbound in between. */
  adopt(server: Server): Promise<void>;
  /** Let the port go. The handle belongs to the last server that adopted it, so that server is closed if it still
      listens; one already closed has let the port go, and the handle must not be closed twice. A fixture that hands
      the port from a bootstrap server to its real one, and stops before the hand-over, leaves the bootstrap holding
      the port, and this is what closes it. */
  release(): Promise<void>;
}

export async function holdPort(): Promise<HeldPort> {
  const holder = createServer();
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const address = holder.address();
  if (!address || typeof address === 'string') throw new Error('held port has no address');
  let owner: Server = holder;
  return {
    port: address.port,
    async adopt(server) {
      owner = server;
      server.listen(holder);
      await once(server, 'listening');
    },
    async release() {
      if (!owner.listening) return;
      (owner as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => owner.close(() => resolve()));
    },
  };
}
