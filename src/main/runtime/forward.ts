import type { ForwardTarget } from '../runner/forwarding'
import type { WorkspaceRuntime } from './types'

/** Connect from inside the container, including to servers bound only to its own loopback. */
const RELAY = `
const net = require('node:net');
function dial(host) {
  let connected = false;
  const socket = net.connect(Number(process.argv[1]), host);
  socket.on('connect', () => {
    connected = true;
    process.stdin.pipe(socket);
    socket.pipe(process.stdout, { end: false });
  });
  socket.on('error', () => {
    if (!connected && host === '127.0.0.1') dial('::1');
    else { process.exitCode = 1; process.stdin.destroy(); process.stdout.end(); }
  });
  socket.on('close', () => {
    if (connected) { process.stdin.destroy(); process.stdout.end(); }
  });
}
dial('127.0.0.1');
process.stdout.on('error', () => process.exit(1));
`

export function openForwardTarget(runtime: WorkspaceRuntime, port: number): ForwardTarget {
  const process = runtime.spawn('node', ['-e', RELAY, String(port)])
  // A failed spawn can emit before the upgrade awaits this target; the transport also
  // checks destroyed streams before accepting it and installs its own teardown listeners.
  process.child.stdin.on('error', () => {})
  process.child.stdout.on('error', () => {})
  process.child.stderr.resume()
  process.child.on('error', (error) => process.child.stdout.destroy(error))
  return {
    input: process.child.stdin,
    output: process.child.stdout,
    close() {
      process.child.stdin.destroy()
      process.child.stdout.destroy()
      process.terminate()
    }
  }
}
