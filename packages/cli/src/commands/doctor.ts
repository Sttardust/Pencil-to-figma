import { loadServiceConfig, PenMcpClient } from "@pen-fig/service";

export async function runDoctor(): Promise<number> {
  console.log("Pencil ↔ Figma Bridge doctor\n");
  let pen: PenMcpClient | undefined;
  try {
    const config = await loadServiceConfig();
    console.log(`✓ Node ${process.version}`);
    console.log(`✓ Pen MCP executable: ${config.penMcpPath}`);
    console.log(`✓ Bridge bind address: ${config.host}:${config.port}`);
    pen = new PenMcpClient(config.penMcpPath);
    const state = await pen.getAppState();
    const active = state.text
      .split("\n")
      .find((line) => line.includes("Currently active canvas editor"));
    console.log(`✓ Pen MCP connection: ${active ?? "connected"}`);
    const roots = await pen.listRootFrames(3);
    console.log("✓ Pen read-only execute: root frames returned");
    if (roots.trim()) console.log(roots.trim());
    console.log("\nDoctor passed.");
    return 0;
  } catch (error) {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    await pen?.close();
  }
}
