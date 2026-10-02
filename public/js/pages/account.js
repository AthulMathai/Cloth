// /account, /account/sign-in, /account/sign-up — Supabase Auth.
import { auth, db } from '../lib/supabase.js';
import { themeForPage } from '../lib/store.js';
import { esc } from '../components/ui.js';

export async function load({ mode }) {
  const theme = await themeForPage('account');
  if (!auth.user || mode) return authForm(theme, mode === 'sign-up' ? 'sign-up' : 'sign-in');

  const [profile, roles] = await Promise.all([
    db.from('profiles').select('full_name,email,phone,marketing_opt_in').eq('id', auth.user.id).single().catch(() => null),
    db.from('user_roles').select('role').eq('user_id', auth.user.id).catch(() => []),
  ]);
  return {
    theme, title: 'Your account',
    html: `<section class="section"><div class="wrap" style="max-width:720px;display:grid;gap:28px">
      <h1 class="h-section">Hi${profile?.full_name ? ', ' + esc(profile.full_name.split(' ')[0]) : ''}.</h1>
      <form class="auth-card" data-profile style="margin:0;max-width:none">
        <div class="field"><label for="full_name">Name</label><input id="full_name" name="full_name" value="${esc(profile?.full_name || '')}" autocomplete="name"></div>
        <div class="field"><label for="phone">Phone</label><input id="phone" name="phone" value="${esc(profile?.phone || '')}" autocomplete="tel"></div>
        <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" name="marketing_opt_in" ${profile?.marketing_opt_in ? 'checked' : ''}> Email me before each drop</label>
        <p class="muted" style="margin:0;font-size:14px">Signed in as ${esc(profile?.email || auth.user.email || '')}${roles.length ? ` · staff roles: ${roles.map(r => esc(r.role)).join(', ')}` : ''}</p>
        <div class="form-row"><button class="btn" type="submit">Save changes</button><button class="btn btn--quiet" type="button" data-signout>Sign out</button></div>
        <p class="form-msg" role="status" data-msg></p>
      </form>
      <nav class="chips"><a class="chip" href="/orders">Orders</a><a class="chip" href="/designs">Saved designs</a><a class="chip" href="/wishlist">Wishlist</a></nav>
    </div></section>`,
    mount(root) {
      const form = root.querySelector('[data-profile]'), msg = root.querySelector('[data-msg]');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const body = { full_name: form.full_name.value.trim() || null, phone: form.phone.value.trim() || null, marketing_opt_in: form.marketing_opt_in.checked };
        try {
          const { env } = await import('../lib/env.js');
          const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${auth.user.id}`, {
            method: 'PATCH', body: JSON.stringify(body),
            headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${auth.session.access_token}`, 'Content-Type': 'application/json' },
          });
          msg.textContent = r.ok ? 'Saved.' : "Couldn't save. Sign in again and retry.";
        } catch { msg.textContent = "Couldn't save. Check your connection."; }
      };
      root.querySelector('[data-signout]').onclick = async () => { await auth.signOut(); (await import('../app.js')).go('/'); };
    },
  };
}

function authForm(theme, mode) {
  const up = mode === 'sign-up';
  return {
    theme, title: up ? 'Create an account' : 'Sign in',
    html: `<section class="section"><form class="auth-card" data-auth novalidate>
      <h1 class="h-section" style="font-size:44px">${up ? 'Create an account' : 'Sign in'}</h1>
      ${up ? `<div class="field"><label for="name">Name</label><input id="name" name="name" autocomplete="name"></div>` : ''}
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" autocomplete="${up ? 'new-password' : 'current-password'}" required></div>
      <button class="btn" type="submit">${up ? 'Create account' : 'Sign in'}</button>
      <p class="form-msg" role="status" data-msg></p>
      <p class="muted" style="margin:0">${up ? 'Have an account? <a href="/account/sign-in">Sign in</a>' : 'New here? <a href="/account/sign-up">Create an account</a> · <button type="button" class="linklike" data-reset style="background:none;border:0;padding:0;text-decoration:underline;cursor:pointer">Forgot password</button>'}</p>
    </form></section>`,
    mount(root) {
      const form = root.querySelector('[data-auth]'), msg = root.querySelector('[data-msg]');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const email = form.email.value.trim(), password = form.password.value;
        if (!email || password.length < 8) { msg.textContent = 'Enter your email and a password of at least 8 characters.'; return; }
        msg.textContent = up ? 'Creating your account…' : 'Signing in…';
        try {
          if (up) {
            const r = await auth.signUp(email, password, form.name.value.trim());
            if (!r.access_token) { msg.textContent = 'Check your email to confirm your account, then sign in.'; return; }
          } else await auth.signIn(email, password);
          (await import('../app.js')).go('/account');
        } catch (err) { msg.textContent = err.message; }
      };
      root.querySelector('[data-reset]')?.addEventListener('click', async () => {
        const email = form.email.value.trim();
        if (!email) { msg.textContent = 'Enter your email first, then choose Forgot password.'; return; }
        try { await auth.sendReset(email); msg.textContent = 'If that email has an account, a reset link is on its way.'; } catch (err) { msg.textContent = err.message; }
      });
    },
  };
}
