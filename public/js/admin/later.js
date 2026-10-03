// Sections that belong to later phases, shown honestly rather than faked.
const INFO = {
  promotions: ['Promotions', 'Marketing phase', 'Automatic flash and seasonal sales (no code needed). Today: set sale prices on products, or create a time-limited discount code under Discounts.'],
};
export async function view(ctx) {
  const [title, phase, text] = INFO[ctx.key];
  return { title, html: `<header class="cc-head"><h1>${title}</h1></header>
    <section class="cc-card"><p><span class="cc-tag">Coming in ${phase}</span></p><p>${text}</p></section>` };
}
