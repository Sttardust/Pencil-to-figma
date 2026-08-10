import { loadServiceConfig } from "./config.js";
import { PenMcpClient } from "./pen/mcp-client.js";
import { BridgeServer } from "./server.js";
import { loadOrCreateReconnectToken } from "./credentials.js";
import { SessionManager } from "./session.js";
import { OperationJournal } from "./operation-journal.js";

const config = await loadServiceConfig();
const pen = new PenMcpClient(config.penMcpPath);
const reconnectToken = await loadOrCreateReconnectToken(config.credentialPath);
const server = new BridgeServer({
  host: config.host,
  port: config.port,
  pen,
  sessions: new SessionManager(reconnectToken),
  journal: new OperationJournal(),
});
const port = await server.start();

console.log(`Pencil ↔ Figma bridge listening on http://${config.host}:${port}`);
if (process.env.NODE_ENV !== "production")
  console.log(`Development pairing code: ${server.pairingCode}`);

async function shutdown(): Promise<void> {
  await server.close();
  await pen.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
