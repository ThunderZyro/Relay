import { parentPort, workerData } from 'node:worker_threads';
import { Pool, type PoolClient } from 'pg';

const connectionString = (workerData as { connectionString?: string })?.connectionString;
if (!connectionString) throw new Error('The Relay database worker requires DATABASE_URL.');
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 0, keepAlive: true });
let clientPromise: Promise<PoolClient> | undefined;

async function getClient() {
  if (!clientPromise) {
    clientPromise = pool.connect().catch(error => { clientPromise = undefined; throw error; });
  }
  return clientPromise;
}
if (!parentPort) throw new Error('Relay database worker requires a parent port.');
parentPort.on('message', async (message: {
  action: 'query' | 'exec'; sql: string; params?: unknown[]; responseBuffer: SharedArrayBuffer;
}) => {
  const header = new Int32Array(message.responseBuffer, 0, 2);
  let response: any;
  try {
    const client = await getClient();
    if (message.action === 'exec') {
      await client.query(message.sql);
      response = { rows: [], rowCount: 0 };
    } else {
      const result = await client.query(message.sql, message.params || []);
      response = { rows: result.rows, rowCount: result.rowCount, command: result.command };
    }
  } catch (error: any) {
    response = { error: { message: error?.message || 'PostgreSQL query failed.', code: error?.code, detail: error?.detail, constraint: error?.constraint } };
  }
  let payload = Buffer.from(JSON.stringify(response), 'utf8');
  if (payload.length > message.responseBuffer.byteLength - 8) {
    payload = Buffer.from(JSON.stringify({ error: { message: 'Database response exceeded the 16 MB worker limit.' } }), 'utf8');
  }
  new Uint8Array(message.responseBuffer, 8, payload.length).set(payload);
  Atomics.store(header, 1, payload.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
});
