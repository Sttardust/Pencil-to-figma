import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const PAIRING_TTL_MS = 60 * 60 * 1000;

export interface PairingSession {
  pairingCode: string;
  sessionToken: string;
  expiresAt: number;
}

export class SessionManager {
  #session: PairingSession = this.#createSession();

  get pairingCode(): string {
    return this.#session.pairingCode;
  }

  pair(code: string): string | undefined {
    if (Date.now() > this.#session.expiresAt) return undefined;
    if (!safeEqual(code, this.#session.pairingCode)) return undefined;
    return this.#session.sessionToken;
  }

  authenticate(token: string): boolean {
    return safeEqual(token, this.#session.sessionToken);
  }

  rotate(): void {
    this.#session = this.#createSession();
  }

  #createSession(): PairingSession {
    return {
      pairingCode: randomBytes(3).toString("hex").toUpperCase(),
      sessionToken: randomUUID(),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
