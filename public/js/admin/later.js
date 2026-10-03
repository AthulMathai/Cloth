// Sections that belong to later phases, shown honestly rather than faked.
const INFO = {
  fulfillment: ['Fulfillment', 'Phase 7', 'Print partners, the partner portal, partner inventory and capacity, automatic routing, production orders and shipping/tracking. Paid orders wait in “Pending” (fulfillment pending) until then.'],
  promotions: ['Promotions', 'Marketing phase', 'Automatic flash and seasonal sales (no code needed). Today: set sale prices on products, or create a time-limited discount code under Discounts.'],
};
export async function view(ctx) {
  const [title, phase, text] = INFO[ctx.key];
  return { title, html: `<header class="ad-head"><h1>${title}</h1></header>
    <section class="ad-card"><p><span class="ad-tag">Coming in ${phase}</span></p><p>${text}</p></section>` };
}
