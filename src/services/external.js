/** Modular external-service adapters. Every adapter degrades gracefully
 *  so the app runs fully offline when nothing is configured. */
import crypto from 'crypto';
import { haversineKm } from '../utils/http.js';

// ---------- OTP / SMS ----------------------------------------------------
export async function sendSms(to, text) {
  if (process.env.SMS_PROVIDER === 'twilio' && process.env.TWILIO_ACCOUNT_SID) {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: text }),
    });
    return { provider: 'twilio', ok: res.ok };
  }
  console.log(`[SMS:console] to ${to}: ${text}`);
  return { provider: 'console', ok: true };
}
export const makeOtp = () => String(crypto.randomInt(100000, 999999));
export const hashOtp = (code) => crypto.createHash('sha256').update(code).digest('hex');

// ---------- Translation --------------------------------------------------
export async function translate(text, target) {
  if (process.env.TRANSLATE_PROVIDER === 'libretranslate' && process.env.LIBRETRANSLATE_URL) {
    const res = await fetch(`${process.env.LIBRETRANSLATE_URL}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'auto', target, format: 'text' }),
    });
    if (res.ok) return { text: (await res.json()).translatedText, provider: 'libretranslate' };
  }
  return { text, provider: 'none', note: 'Translation service not configured; original text returned' };
}

// ---------- Routing ------------------------------------------------------
export async function route(from, to) {
  if (process.env.ROUTING_PROVIDER === 'osrm') {
    try {
      const url = `${process.env.OSRM_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const r = await (await fetch(url)).json();
      const best = r.routes?.[0];
      if (best) return { distanceKm: +(best.distance / 1000).toFixed(2), durationMin: Math.round(best.duration / 60),
        geometry: best.geometry.coordinates.map(([lng, lat]) => [lat, lng]), provider: 'osrm' };
    } catch { /* fall through */ }
  }
  const km = haversineKm(from, to);
  return { distanceKm: +km.toFixed(2), durationMin: Math.round((km / 20) * 60 + 5), geometry: [[from.lat, from.lng], [to.lat, to.lng]], provider: 'straight-line estimate' };
}

// ---------- Payments -----------------------------------------------------
export async function createPaymentOrder(amount, currency, receipt) {
  if (process.env.PAYMENT_PROVIDER === 'razorpay' && process.env.RAZORPAY_KEY_ID) {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(amount * 100), currency, receipt }),
    });
    if (!res.ok) throw new Error('Payment gateway error');
    const o = await res.json();
    return { provider: 'razorpay', providerOrderId: o.id, keyId: process.env.RAZORPAY_KEY_ID, status: 'CREATED' };
  }
  return { provider: 'none', status: 'PAY_AT_PICKUP', note: 'Online payment not configured; pay at pickup.' };
}
export function verifyRazorpaySignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${orderId}|${paymentId}`).digest('hex');
  return expected === signature;
}

export const externalStatus = () => ({
  sms: process.env.SMS_PROVIDER === 'twilio' && !!process.env.TWILIO_ACCOUNT_SID ? 'twilio' : 'console',
  translation: process.env.TRANSLATE_PROVIDER === 'libretranslate' && process.env.LIBRETRANSLATE_URL ? 'libretranslate' : 'not configured',
  routing: process.env.ROUTING_PROVIDER === 'osrm' ? 'osrm' : 'straight-line estimate',
  payments: process.env.PAYMENT_PROVIDER === 'razorpay' && process.env.RAZORPAY_KEY_ID ? 'razorpay' : 'not configured (pay at pickup)',
});
