import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const PAIRING_TTL_MS = 60 * 60 * 1000;
const MAX_FAILED_PAIRING_ATTEMPTS = 10;

export interface PairingSession {
  pairingCode: string;
  sessionToken: string;
  expiresAt: number;
}

export interface SessionCredentials {
  token: string;
  reconnectToken: string;
}

export class SessionManager {
  #session: PairingSession = this.#createSession();
  #failedPairingAttempts = 0;
  #pairingLocked = false;

  constructor(readonly reconnectToken: string = randomUUID()) {}

  get pairingCode(): string {
    return this.#session.pairingCode;
  }

  pair(code: string): SessionCredentials | undefined {
    if (this.#pairingLocked || Date.now() > this.#session.expiresAt)
      return undefined;
    if (!safeEqual(code, this.#session.pairingCode)) {
      this.#failedPairingAttempts += 1;
      if (this.#failedPairingAttempts >= MAX_FAILED_PAIRING_ATTEMPTS)
        this.#pairingLocked = true;
      return undefined;
    }
    this.#failedPairingAttempts = 0;
    return this.#credentials();
  }

  reconnect(reconnectToken: string): SessionCredentials | undefined {
    if (!safeEqual(reconnectToken, this.reconnectToken)) return undefined;
    return this.#credentials();
  }

  approve(): SessionCredentials {
    this.#failedPairingAttempts = 0;
    return this.#credentials();
  }

  authenticate(token: string): boolean {
    return safeEqual(token, this.#session.sessionToken);
  }

  rotate(): void {
    this.#session = this.#createSession();
    this.#failedPairingAttempts = 0;
    this.#pairingLocked = false;
  }

  #createSession(): PairingSession {
    return {
      pairingCode: randomBytes(3).toString("hex").toUpperCase(),
      sessionToken: randomUUID(),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
  }

  #credentials(): SessionCredentials {
    return {
      token: this.#session.sessionToken,
      reconnectToken: this.reconnectToken,
    };
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
