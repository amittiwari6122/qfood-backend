import { Router } from 'express';
import Donation from '../models/Donation.js';
import FoodRequest from '../models/FoodRequest.js';
import Delivery from '../models/Delivery.js';
import User from '../models/User.js';
import { QuantumMatchingRun } from '../models/Quantum.js';
import { Feedback, Order } from '../models/Misc.js';
import { protect, authorize } from '../middleware/auth.js';
import { createPaymentOrder, verifyRazorpaySignature, externalStatus } from '../services/external.js';
import { aiInfo } from '../services/ai/foodQuality.js';
import { storageInfo } from '../services/storage/index.js';
import { quantumHealth } from '../services/quantum.js';
import { notify } from '../services/notify.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
const KG_PER_MEAL = 0.4; // documented assumption used for "food saved" estimates

// ---------- public (landing page) -----------------------------------------
r.get('/public/stats', asyncHandler(async (_req, res) => {
  const [completed, ngos, donors] = await Promise.all([
    Donation.aggregate([{ $match: { status: 'COMPLETED' } }, { $group: { _id: null, n: { $sum: 1 }, people: { $sum: '$peopleServed' }, qty: { $sum: '$quantity' } } }]),
    User.countDocuments({ role: 'NGO', verificationStatus: 'VERIFIED' }),
    User.countDocuments({ role: 'DONOR' }),
  ]);
  const c = completed[0] || { n: 0, people: 0, qty: 0 };
  res.json({ donationsCompleted: c.n, peopleServed: c.people, foodSavedKg: Math.round(c.qty * KG_PER_MEAL), verifiedNgos: ngos, donors });
}));
r.get('/public/testimonials', asyncHandler(async (_req, res) => {
  res.json(await Feedback.find({ public: true, rating: { $gte: 4 }, comment: { $exists: true, $ne: '' } }).populate('from', 'name role').sort('-createdAt').limit(6));
}));

r.use(protect);

// ---------- system status (which external services are live) ---------------
r.get('/system', asyncHandler(async (_req, res) => {
  res.json({ ai: aiInfo(), storage: storageInfo(), quantum: await quantumHealth(), ...externalStatus() });
}));

// ---------- per-role dashboard numbers --------------------------------------
r.get('/me', asyncHandler(async (req, res) => {
  const u = req.user;
  if (u.role === 'DONOR') {
    const by = await Donation.aggregate([{ $match: { donor: u._id } }, { $group: { _id: '$status', n: { $sum: 1 }, people: { $sum: '$peopleServed' }, qty: { $sum: '$quantity' } } }]);
    const get = (s) => by.find((b) => b._id === s) || { n: 0, people: 0, qty: 0 };
    const total = by.reduce((s, b) => s + b.n, 0);
    const done = get('COMPLETED');
    return res.json({ total, available: get('AVAILABLE').n, matched: get('MATCHED').n + get('ACCEPTED').n, inTransit: get('IN_TRANSIT').n,
      completed: done.n, peopleServed: done.people, foodSavedKg: Math.round(done.qty * KG_PER_MEAL), pendingReview: get('PENDING_REVIEW').n, expired: get('EXPIRED').n });
  }
  if (['NGO', 'BENEFICIARY'].includes(u.role)) {
    const reqs = await FoodRequest.aggregate([{ $match: { requester: u._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const dels = await Delivery.aggregate([{ $match: { recipient: u._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const g = (arr, s) => arr.find((x) => x._id === s)?.n || 0;
    return res.json({ openRequests: g(reqs, 'OPEN') + g(reqs, 'PARTIALLY_FULFILLED'), fulfilled: g(reqs, 'FULFILLED'),
      activeDeliveries: g(dels, 'ASSIGNED') + g(dels, 'IN_TRANSIT') + g(dels, 'AWAITING_PARTNER'), received: g(dels, 'DELIVERED') });
  }
  if (u.role === 'DELIVERY') {
    const dels = await Delivery.aggregate([{ $match: { partner: u._id } }, { $group: { _id: '$status', n: { $sum: 1 }, km: { $sum: '$route.distanceKm' } } }]);
    const g = (s) => dels.find((x) => x._id === s) || { n: 0, km: 0 };
    return res.json({ active: g('ASSIGNED').n + g('IN_TRANSIT').n, delivered: g('DELIVERED').n, km: Math.round(g('DELIVERED').km), failed: g('FAILED').n });
  }
  res.json({});
}));

// ---------- admin analytics -------------------------------------------------
r.get('/admin', authorize('ADMIN'), asyncHandler(async (req, res) => {
  const days = Math.min(+req.query.days || 14, 90);
  const since = new Date(Date.now() - days * 864e5);
  const [daily, byStatus, byCategory, users, runs, aiDist, pendingNgos, pendingReview] = await Promise.all([
    Donation.aggregate([{ $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, donations: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        expired: { $sum: { $cond: [{ $eq: ['$status', 'EXPIRED'] }, 1, 0] } } } }, { $sort: { _id: 1 } }]),
    Donation.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Donation.aggregate([{ $group: { _id: '$category', n: { $sum: 1 }, qty: { $sum: '$quantity' } } }]),
    User.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]),
    QuantumMatchingRun.find({ status: { $in: ['success', 'no_feasible', 'FAILED'] } }).select('createdAt status executionTime numberOfVariables objectiveValue assignments executionMode').sort('-createdAt').limit(20),
    Donation.aggregate([{ $group: { _id: '$ai.status', n: { $sum: 1 } } }]),
    User.countDocuments({ role: 'NGO', verificationStatus: { $in: ['PENDING', 'REVIEW_REQUIRED'] } }),
    Donation.countDocuments({ status: 'PENDING_REVIEW' }),
  ]);
  const completed = byStatus.find((s) => s._id === 'COMPLETED')?.n || 0;
  const expired = byStatus.find((s) => s._id === 'EXPIRED')?.n || 0;
  res.json({ daily, byStatus, byCategory, users, aiDist, pendingNgos, pendingReview,
    rescueRate: completed + expired ? Math.round((completed / (completed + expired)) * 100) : null,
    runs: runs.map((x) => ({ at: x.createdAt, status: x.status, seconds: x.executionTime, qubits: x.numberOfVariables, objective: x.objectiveValue, matches: x.assignments?.length || 0, mode: x.executionMode })) });
}));

r.get('/admin/export.csv', authorize('ADMIN'), asyncHandler(async (_req, res) => {
  const rows = await Donation.find().populate('donor', 'name').sort('-createdAt').limit(5000).lean();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['id,created,donor,food,category,quantity,unit,status,ai_status,usable_until'];
  for (const d of rows) lines.push([d._id, d.createdAt.toISOString(), d.donor?.name, d.foodName, d.category, d.quantity, d.unit, d.status, d.ai?.status, d.usableUntil.toISOString()].map(esc).join(','));
  res.type('text/csv').attachment('donations.csv').send(lines.join('\n'));
}));

// ---------- limited-time food selling ----------------------------------------
r.get('/market', asyncHandler(async (_req, res) => {
  res.json(await Donation.find({ 'forSale.enabled': true, status: 'AVAILABLE', usableUntil: { $gt: new Date() } }).populate('donor', 'name city').sort('usableUntil').limit(60));
}));

r.post('/market/:id/order', authorize('BENEFICIARY', 'NGO'), asyncHandler(async (req, res) => {
  const qty = Math.max(1, +req.body.quantity || 1);
  const d = await Donation.findOneAndUpdate({ _id: req.params.id, 'forSale.enabled': true, status: 'AVAILABLE', quantity: { $gte: qty }, usableUntil: { $gt: new Date() } },
    { $inc: { quantity: -qty } }, { new: true });
  if (!d) throw new ApiError(409, 'Not enough left, or the offer has ended');
  if (d.quantity === 0) { d.status = 'COMPLETED'; await d.save(); }
  const amount = qty * d.forSale.price;
  const pay = await createPaymentOrder(amount, d.forSale.currency, `don_${d._id}`);
  const order = await Order.create({ buyer: req.user._id, donation: d._id, quantity: qty, amount, provider: pay.provider, providerOrderId: pay.providerOrderId, status: pay.status });
  await notify(d.donor, { type: 'order', title: 'New order', body: `${req.user.name} ordered ${qty} ${d.unit} of ${d.foodName}.` });
  res.status(201).json({ order, payment: pay });
}));

r.post('/market/orders/:id/verify', asyncHandler(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, buyer: req.user._id });
  if (!o) throw new ApiError(404, 'Order not found');
  const ok = verifyRazorpaySignature(o.providerOrderId, req.body.paymentId, req.body.signature);
  o.status = ok ? 'PAID' : 'FAILED';
  await o.save();
  res.json(o);
}));

export default r;
