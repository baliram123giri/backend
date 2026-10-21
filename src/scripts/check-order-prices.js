// Read-only: compare recent orders with the Template prices in the database.
//
// Usage (from backend/, with the DB reachable):  node src/scripts/check-order-prices.js [count]
//
// "gross" is what the customer was priced at before any coupon: amount charged + discount applied. A coupon
// can push a tiny total up to the ₹1 gateway minimum, so differences under ₹1 are treated as a match.
// No customer details are printed.
import 'dotenv/config';
import { prisma } from '../lib/prisma.js';
import { priceForFormat } from '../services/pricing.js';

const count = Math.max(1, Math.min(2000, Number(process.argv[2]) || 200));

const orders = await prisma.order.findMany({
  where: { NOT: { razorpayOrderId: { startsWith: 'mock_' } } },
  orderBy: { createdAt: 'desc' },
  take: count,
  select: {
    razorpayOrderId: true, status: true, amount: true, discountApplied: true,
    format: true, templateId: true, couponCode: true, createdAt: true,
  },
});
const templates = await prisma.template.findMany({
  where: { id: { in: [...new Set(orders.map((o) => o.templateId))] } },
  select: {
    id: true, name: true, updatedAt: true, discountPrice: true, pdfDiscountPrice: true, docxDiscountPrice: true,
    jpgDiscountPrice: true, pngDiscountPrice: true, comboDiscountPrice: true,
  },
});
const byId = Object.fromEntries(templates.map((t) => [t.id, t]));

const tally = { match: 0, under: 0, over: 0, noTemplate: 0 };
for (const o of orders) {
  const t = byId[o.templateId];
  const day = o.createdAt.toISOString().slice(0, 10);
  if (!t) {
    tally.noTemplate++;
    console.log(`NO-TEMPLATE  ${day} ${o.status.padEnd(9)} ${o.format}`);
    continue;
  }
  const gross = +(o.amount + (o.discountApplied || 0)).toFixed(2);
  const expected = priceForFormat(o.format, t);
  if (Math.abs(gross - expected) <= 1) { tally.match++; continue; }
  const kind = gross < expected ? 'under' : 'over';
  tally[kind]++;
  console.log(
    `${kind.toUpperCase().padEnd(12)} ${day} ${o.status.padEnd(9)} ${String(o.format).padEnd(5)} ` +
    `priced ${gross} vs database ${expected} | template edited ${t.updatedAt.toISOString().slice(0, 10)} | ${t.name.slice(0, 32)}`
  );
}
console.log(`\nChecked ${orders.length} orders:`, JSON.stringify(tally));
console.log('"under" orders dated AFTER the template was last edited were priced below the database price at the time.');
await prisma.$disconnect();
process.exit(0);
