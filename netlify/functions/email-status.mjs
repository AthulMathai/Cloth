// GET /api/email-status — which email provider is connected (no secrets).
import { json } from '../lib/http.mjs';
import { emailProvider } from '../lib/email.mjs';

export default async () => json(200, {
  provider: emailProvider(), test_mode: emailProvider() === 'mock',
  from: process.env.EMAIL_FROM || (emailProvider() === 'resend' ? 'onboarding@resend.dev' : null),
  shared_sender: emailProvider() === 'resend' && !process.env.EMAIL_FROM,
}, { 'Cache-Control': 'public, max-age=300' });
