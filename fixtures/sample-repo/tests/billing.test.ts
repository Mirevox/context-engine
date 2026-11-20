import { calculateInvoice } from "../src/billing.js";

console.assert(calculateInvoice([10, 20]) === 36, "tax applied");
