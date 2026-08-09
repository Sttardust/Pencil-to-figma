import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session.js";

describe("SessionManager", () => {
  it("pairs with the displayed code and authenticates its token", () => {
    const sessions = new SessionManager();
    const credentials = sessions.pair(sessions.pairingCode);
    expect(credentials?.token).toBeTypeOf("string");
    expect(sessions.authenticate(credentials!.token)).toBe(true);
    expect(sessions.authenticate("wrong")).toBe(false);
    expect(sessions.pair(sessions.pairingCode)).toEqual(credentials);
    expect(sessions.reconnect(credentials!.reconnectToken)).toEqual(
      credentials,
    );
  });

  it("invalidates the old code and token after rotation", () => {
    const sessions = new SessionManager();
    const code = sessions.pairingCode;
    const credentials = sessions.pair(code)!;
    sessions.rotate();
    expect(sessions.pair(code)).toBeUndefined();
    expect(sessions.authenticate(credentials.token)).toBe(false);
    const reconnected = sessions.reconnect(credentials.reconnectToken);
    expect(reconnected?.token).not.toBe(credentials.token);
    expect(sessions.authenticate(reconnected!.token)).toBe(true);
  });

  it("rejects an unknown reconnect token", () => {
    const sessions = new SessionManager();
    expect(sessions.reconnect("wrong")).toBeUndefined();
  });

  it("locks pairing after repeated incorrect codes", () => {
    const sessions = new SessionManager();
    const correctCode = sessions.pairingCode;
    const wrongCode = correctCode === "000000" ? "FFFFFF" : "000000";
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect(sessions.pair(wrongCode)).toBeUndefined();
    expect(sessions.pair(correctCode)).toBeUndefined();

    sessions.rotate();
    expect(sessions.pair(sessions.pairingCode)).toBeDefined();
  });
});
