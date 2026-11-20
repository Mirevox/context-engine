/**
 * Entry point: wires the authentication and billing modules together.
 */
import { authenticate } from "./auth.js";
import { calculateInvoice } from "./billing.js";

export function handleRequest(token: string, items: number[]): number {
  if (!authenticate(token)) throw new Error("unauthorized");
  return calculateInvoice(items);
}
