/**
 * AI Food Quality Analysis - provider abstraction.
 *   AI_PROVIDER=none       -> no analysis; donation goes to manual review
 *   AI_PROVIDER=dev        -> development analysis mode: REAL image measurements
 *                             (resolution, exposure, sharpness) only. It does not
 *                             claim to detect spoilage, so it always asks for review.
 *   AI_PROVIDER=anthropic  -> Claude vision model (needs ANTHROPIC_API_KEY)
 *   AI_PROVIDER=http       -> your own model server at AI_HTTP_ENDPOINT
 * The result is decision support only - backend safety rules still apply.
 */
import sharp from 'sharp';
import env from '../../config/env.js';

const STATUSES = ['SAFE', 'CAUTION', 'UNSAFE', 'MANUAL_REVIEW'];

async function imageMetrics(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const stats = await img.clone().stats();
  const brightness = stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;
  // Sharpness: std-dev of a Laplacian-filtered greyscale image
  const lap = await img.clone().greyscale().resize({ width: 512, withoutEnlargement: true })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] }).stats();
  return { width: meta.width, height: meta.height, brightness: Math.round(brightness), sharpness: +lap.channels[0].stdev.toFixed(2) };
}

const providers = {
  async none() {
    return { status: 'MANUAL_REVIEW', qualityScore: null, confidence: null, indicators: [],
      recommendation: 'AI model not configured. An admin will review this donation.', mode: 'not_configured' };
  },

  async dev(buffer) {
    const m = await imageMetrics(buffer);
    const indicators = [];
    if (Math.min(m.width, m.height) < 400) indicators.push('Low resolution image');
    if (m.brightness < 50) indicators.push('Image too dark to inspect');
    if (m.brightness > 225) indicators.push('Image overexposed');
    if (m.sharpness < 6) indicators.push('Image blurry');
    const imageOk = indicators.length === 0;
    return {
      status: 'MANUAL_REVIEW', qualityScore: null, confidence: null,
      indicators: imageOk ? ['Image clear enough for human review'] : indicators,
      recommendation: imageOk
        ? 'Development analysis mode: image quality was measured but food condition was not assessed. Sent for manual review.'
        : 'Development analysis mode: retake the photo in good light so a reviewer can inspect the food.',
      mode: 'development', imageMetrics: m,
    };
  },

  async anthropic(buffer, ctx) {
    if (!process.env.ANTHROPIC_API_KEY) return providers.none();
    const jpeg = await sharp(buffer).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const prompt = `You are a food-donation visual screening assistant. Inspect the photo of "${ctx.foodName}" (${ctx.category}, stored ${ctx.storageCondition}).
Assess ONLY what is visible: freshness cues, visible spoilage (mould, sliminess), discoloration, abnormal appearance, packaging condition, and whether the image is good enough to judge.
You cannot certify safety. Respond with JSON only:
{"status":"SAFE|CAUTION|UNSAFE|MANUAL_REVIEW","qualityScore":0-100,"confidence":0-100,"indicators":["..."],"recommendation":"..."}
Use MANUAL_REVIEW if the image is unclear or the food is not identifiable.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: prompt }] }] }),
    });
    if (!res.ok) throw new Error(`AI provider error ${res.status}`);
    const data = await res.json();
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { ...parsed, mode: 'model', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' };
  },

  async http(buffer, ctx) {
    if (!process.env.AI_HTTP_ENDPOINT) return providers.none();
    const form = new FormData();
    form.append('image', new Blob([buffer]), 'food.jpg');
    form.append('context', JSON.stringify(ctx));
    const res = await fetch(process.env.AI_HTTP_ENDPOINT, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`AI model server error ${res.status}`);
    return { ...(await res.json()), mode: 'model' };
  },
};

export async function analyzeFood(buffer, ctx = {}) {
  const provider = providers[env.aiProvider] ? env.aiProvider : 'none';
  let r;
  try { r = await providers[provider](buffer, ctx); } catch (e) {
    r = { status: 'MANUAL_REVIEW', indicators: ['AI analysis failed'], recommendation: `AI service error: ${e.message}. Sent for manual review.`, mode: 'error' };
  }
  if (!STATUSES.includes(r.status)) r.status = 'MANUAL_REVIEW';
  const norm = (v) => (v == null ? null : Math.max(0, Math.min(100, Number(v))));
  return { ...r, qualityScore: norm(r.qualityScore), confidence: norm(r.confidence), provider, analyzedAt: new Date() };
}

export const aiInfo = () => ({ provider: env.aiProvider,
  configured: env.aiProvider === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : env.aiProvider === 'http' ? !!process.env.AI_HTTP_ENDPOINT : env.aiProvider === 'dev' });
