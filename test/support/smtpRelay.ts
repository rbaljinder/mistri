/**
 * A relay that speaks just enough SMTP for a test: STARTTLS offered only when
 * asked, AUTH, and the RCPT reply the test picks. It keeps every command line
 * it was sent and, per message, the envelope and the message as it was meant
 * (CRLF line ends, a doubled leading dot undone), so a test can read the
 * headers and verify a signature over the exact bytes.
 */
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';

export interface RelayedMessage {
  from: string;
  to: string[];
  raw: string;
}

export async function smtpRelay(options: { starttls?: boolean; rcpt?: string } = {}) {
  const seen: string[] = [];
  const messages: RelayedMessage[] = [];
  let data = '';
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';
    let current: RelayedMessage = { from: '', to: [], raw: '' };
    socket.write('220 relay.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = { from: '', to: [], raw: '' };
            socket.write('250 queued\r\n');
          } else {
            data += `${line}\n`;
            current.raw += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        seen.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write(`250-relay.test\r\n${options.starttls ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`);
        else if (verb === 'AUTH') socket.write('235 ok\r\n');
        else if (verb === 'MAIL') {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          socket.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          socket.write(`${options.rcpt ?? '250 ok'}\r\n`);
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('502 no\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { port, seen, messages, data: () => data, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
