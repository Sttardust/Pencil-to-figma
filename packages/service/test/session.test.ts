import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session.js";

describe("SessionManager", () => {
  it("pairs with the displayed code and authenticates its token", () => {
    const sessions = new SessionManager();
    const token = sessions.pair(sessions.pairingCode);
    expect(token).toBeTypeOf("string");
    expect(sessions.authenticate(token!)).toBe(true);
    expect(sessions.authenticate("wrong")).toBe(false);
    expect(sessions.pair(sessions.pairingCode)).toBe(token);
  });

  it("invalidates the old code and token after rotation", () => {
    const sessions = new SessionManager();
    const code = sessions.pairingCode;
    const token = sessions.pair(code)!;
    sessions.rotate();
    expect(sessions.pair(code)).toBeUndefined();
    expect(sessions.authenticate(token)).toBe(false);
  });
});
