// Billing calculator: sums line items and applies tax to produce an invoice total.
export const TAX_RATE = 0.2;

export function calculateInvoice(items: number[]): number {
  const subtotal = items.reduce((a, b) => a + b, 0);
  return Math.round(subtotal * (1 + TAX_RATE) * 100) / 100;
}

export class InvoiceBuilder {
  private lines: number[] = [];
  add(amount: number): this {
    this.lines.push(amount);
    return this;
  }
  total(): number {
    return calculateInvoice(this.lines);
  }
}
