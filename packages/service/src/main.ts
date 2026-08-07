import { loadServiceConfig } from "./config.js";
import { PenMcpClient } from "./pen/mcp-client.js";
import { BridgeServer } from "./server.js";

const config = await loadServiceConfig();
const pen = new PenMcpClient(config.penMcpPath);
const server = new BridgeServer({ host: config.host, port: config.port, pen });
const port = await server.start();

console.log(`Pencil ↔ Figma bridge listening on http://${config.host}:${port}`);
console.log(`Pairing code: ${server.pairingCode}`);

async function shutdown(): Promise<void> {
  await server.close();
  await pen.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
