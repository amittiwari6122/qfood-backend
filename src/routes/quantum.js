import { Router } from 'express';
import { body } from 'express-validator';
import Donation from '../models/Donation.js';
import FoodRequest from '../models/FoodRequest.js';
import Delivery from '../models/Delivery.js';
import { QuantumMatchingRun, QuantumMatchingAssignment } from '../models/Quantum.js';
import { Conversation } from '../models/Misc.js';
import { protect, authorize, requireVerified } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { runMatching, scheduleRematch, quantumHealth, buildProblem, isRunning } from '../services/quantum.js';
import { notify, notifyMany } from '../services/notify.js';
import { emitToRole } from '../services/socket.js';
import { makeOtp, route } from '../services/external.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
r.use(protect);

r.get('/health', asyncHandler(async (_req, res) => res.json({ ...(await quantumHealth()), running: isRunning() })));

r.get('/problem', authorize('ADMIN', 'NGO', 'DONOR'), asyncHandler(async (_req, res) => {
  const p = await buildProblem();
  res.json({ donations: p.donations.length, requests: p.requests.length, partners: p.deliveryPartners.length,
    possibleAssignments: p.donations.length * p.requests.length });
}));

r.post('/run', authorize('ADMIN', 'DONOR', 'NGO', 'BENEFICIARY'), asyncHandler(async (req, res) => {
  res.json(await runMatching({ trigger: 'manual', userId: req.user._id }));
}));

r.get('/runs', authorize('ADMIN', 'NGO', 'DONOR'), asyncHandler(async (_req, res) => {
  res.json(await QuantumMatchingRun.find().select('-visualization -pruned').sort('-createdAt').limit(30));
}));

r.get('/runs/latest', asyncHandler(async (_req, res) => {
  res.json(await QuantumMatchingRun.findOne({ status: { $in: ['success', 'no_feasible'] } }).sort('-createdAt'));
}));

r.get('/runs/:runId', authorize('ADMIN', 'NGO', 'DONOR'), asyncHandler(async (req, res) => {
  const run = await QuantumMatchingRun.findOne({ runId: req.params.runId });
  if (!run) throw new ApiError(404, 'Run not found');
  res.json(run);
}));

// ---- NGO / beneficiary: view and act on proposed matches ----------------
r.get('/matches', authorize('NGO', 'BENEFICIARY', 'ADMIN'), asyncHandler(async (req, res) => {
  const f = req.user.role === 'ADMIN' ? {} : { ngoId: req.user._id };
  const list = await QuantumMatchingAssignment.find({ ...f, assignmentStatus: { $in: ['PROPOSED', 'ACCEPTED'] } })
    .populate({ path: 'donationId', populate: { path: 'donor', select: 'name' } }).populate('requestId').sort('-createdAt').limit(100);
  res.json(list);
}));

r.post('/matches/:id/accept', authorize('NGO', 'BENEFICIARY'), requireVerified, asyncHandler(async (req, res) => {
  const a = await QuantumMatchingAssignment.findOne({ _id: req.params.id, ngoId: req.user._id, assignmentStatus: 'PROPOSED' });
  if (!a) throw new ApiError(404, 'Match not found or no longer open');
  const d = await Donation.findById(a.donationId);
  if (!d || d.status !== 'MATCHED' || d.usableUntil <= new Date()) {
    a.assignmentStatus = 'SUPERSEDED'; await a.save();
    throw new ApiError(409, 'This donation is no longer available');
  }
  const fr = await FoodRequest.findById(a.requestId);
  a.assignmentStatus = 'ACCEPTED'; await a.save();
  d.status = 'ACCEPTED'; await d.save();
  fr.fulfilledQuantity += a.quantity;
  fr.status = fr.fulfilledQuantity >= fr.quantity ? 'FULFILLED' : 'PARTIALLY_FULFILLED';
  await fr.save();

  const pickup = { address: d.address, lat: d.location.coordinates[1], lng: d.location.coordinates[0] };
  const dropoff = { address: fr.address, lat: fr.location.coordinates[1], lng: fr.location.coordinates[0] };
  const delivery = await Delivery.create({ donation: d._id, assignment: a._id, recipient: req.user._id, pickup, dropoff,
    pickupOtp: makeOtp(), dropoffOtp: makeOtp(), route: await route(pickup, dropoff), timeline: [{ status: 'AWAITING_PARTNER' }] });
  await Conversation.create({ participants: [d.donor, req.user._id], donation: d._id, delivery: delivery._id });

  await notify(d.donor, { type: 'accepted', title: 'NGO accepted your food', body: `${req.user.name} accepted ${d.foodName}. A delivery partner is being assigned.`, link: '/app/deliveries' });
  emitToRole('DELIVERY', 'delivery:new', { deliveryId: delivery._id, distanceKm: delivery.route.distanceKm });
  res.json({ assignment: a, delivery });
}));

r.post('/matches/:id/reject', authorize('NGO', 'BENEFICIARY'), validate([body('reason').optional().isLength({ max: 300 })]), asyncHandler(async (req, res) => {
  const a = await QuantumMatchingAssignment.findOne({ _id: req.params.id, ngoId: req.user._id, assignmentStatus: 'PROPOSED' });
  if (!a) throw new ApiError(404, 'Match not found or no longer open');
  a.assignmentStatus = 'REJECTED'; await a.save();
  const d = await Donation.findById(a.donationId);
  if (d && d.status === 'MATCHED') {
    d.status = 'AVAILABLE'; d.matchedNgo = undefined; d.matchedRequest = undefined; d.rejectedBy.push(req.user._id);
    await d.save();
    await notify(d.donor, { type: 'rematch', title: 'Finding another NGO', body: `${d.foodName} was declined${req.body.reason ? `: ${req.body.reason}` : ''}. Rematching now.` });
  }
  scheduleRematch('NGO rejected donation');
  res.json(a);
}));

export default r;
