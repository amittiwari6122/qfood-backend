import { Router } from 'express';
import { body } from 'express-validator';
import Delivery from '../models/Delivery.js';
import Donation from '../models/Donation.js';
import { QuantumMatchingAssignment } from '../models/Quantum.js';
import { Conversation } from '../models/Misc.js';
import { protect, authorize, requireVerified } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { notifyMany, notify } from '../services/notify.js';
import { emitToRoom } from '../services/socket.js';
import { scheduleRematch } from '../services/quantum.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
r.use(protect);
const POP = [{ path: 'donation', select: 'foodName quantity unit donor usableUntil images isVeg' }, { path: 'recipient', select: 'name phone' }, { path: 'partner', select: 'name phone vehicle' }];

function canSee(d, u) {
  if (u.role === 'ADMIN') return true;
  return [d.partner?._id ?? d.partner, d.recipient?._id ?? d.recipient, d.donation?.donor].some((x) => x?.toString() === u._id.toString());
}
const push = (d, status, note) => { d.status = status; d.timeline.push({ status, note }); };
const broadcast = (d) => emitToRoom(`delivery:${d._id}`, 'delivery:update', { deliveryId: d._id, status: d.status, timeline: d.timeline });

r.get('/', asyncHandler(async (req, res) => {
  const u = req.user;
  let f = {};
  if (u.role === 'DELIVERY') f = { partner: u._id };
  if (['NGO', 'BENEFICIARY'].includes(u.role)) f = { recipient: u._id };
  if (u.role === 'DONOR') f = { donation: { $in: await Donation.find({ donor: u._id }).distinct('_id') } };
  res.json(await Delivery.find(f).populate(POP).sort('-createdAt').limit(100));
}));

r.get('/open', authorize('DELIVERY'), asyncHandler(async (_req, res) => {
  res.json(await Delivery.find({ status: 'AWAITING_PARTNER' }).populate(POP).sort('createdAt'));
}));

r.get('/:id', asyncHandler(async (req, res) => {
  const d = await Delivery.findById(req.params.id).populate(POP).select('+pickupOtp +dropoffOtp');
  if (!d || !canSee(d, req.user)) throw new ApiError(404, 'Delivery not found');
  const o = d.toObject();
  // Each party sees only the code they must hand over.
  if (d.donation?.donor?.toString() !== req.user._id.toString()) delete o.pickupOtp;
  if (d.recipient?._id?.toString() !== req.user._id.toString()) delete o.dropoffOtp;
  res.json(o);
}));

r.post('/:id/claim', authorize('DELIVERY'), requireVerified, asyncHandler(async (req, res) => {
  const d = await Delivery.findOneAndUpdate({ _id: req.params.id, status: 'AWAITING_PARTNER' },
    { partner: req.user._id, status: 'ASSIGNED', $push: { timeline: { status: 'ASSIGNED', note: req.user.name } } }, { new: true }).populate(POP);
  if (!d) throw new ApiError(409, 'Another partner already took this delivery');
  await Conversation.updateOne({ delivery: d._id }, { $addToSet: { participants: req.user._id } });
  await notifyMany([d.donation.donor, d.recipient._id], { type: 'delivery', title: 'Delivery partner assigned', body: `${req.user.name} is on the way to pick up ${d.donation.foodName}.`, link: `/app/track/${d._id}` });
  broadcast(d);
  res.json(d);
}));

r.post('/:id/pickup', authorize('DELIVERY'), validate([body('otp').isLength({ min: 6, max: 6 }).withMessage('Enter the 6-digit pickup code from the donor')]), asyncHandler(async (req, res) => {
  const d = await Delivery.findOne({ _id: req.params.id, partner: req.user._id, status: 'ASSIGNED' }).select('+pickupOtp').populate(POP);
  if (!d) throw new ApiError(404, 'Delivery not found');
  if (d.pickupOtp !== req.body.otp) throw new ApiError(400, 'Pickup code does not match');
  push(d, 'PICKED_UP'); push(d, 'IN_TRANSIT');
  await d.save();
  await Donation.updateOne({ _id: d.donation._id }, { status: 'IN_TRANSIT' });
  await notify(d.recipient._id, { type: 'delivery', title: 'Food picked up', body: `${d.donation.foodName} is on the way.`, link: `/app/track/${d._id}` });
  broadcast(d);
  res.json(d);
}));

r.post('/:id/location', authorize('DELIVERY'), validate([body('lat').isFloat(), body('lng').isFloat()]), asyncHandler(async (req, res) => {
  const d = await Delivery.findOne({ _id: req.params.id, partner: req.user._id, status: { $in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } });
  if (!d) throw new ApiError(404, 'No active delivery');
  const pt = { lat: +req.body.lat, lng: +req.body.lng, at: new Date() };
  d.track.push(pt);
  if (d.track.length > 500) d.track = d.track.slice(-500);
  await d.save();
  req.user.location = { type: 'Point', coordinates: [pt.lng, pt.lat] }; req.user.lastLocationAt = pt.at;
  await req.user.save();
  emitToRoom(`delivery:${d._id}`, 'tracking:location', { deliveryId: d._id, ...pt });
  res.json({ ok: true });
}));

r.post('/:id/deliver', authorize('DELIVERY'), validate([body('otp').isLength({ min: 6, max: 6 }).withMessage('Enter the 6-digit code from the recipient')]), asyncHandler(async (req, res) => {
  const d = await Delivery.findOne({ _id: req.params.id, partner: req.user._id, status: 'IN_TRANSIT' }).select('+dropoffOtp').populate(POP);
  if (!d) throw new ApiError(404, 'Delivery not found');
  if (d.dropoffOtp !== req.body.otp) throw new ApiError(400, 'Delivery code does not match');
  push(d, 'DELIVERED');
  await d.save();
  await Donation.updateOne({ _id: d.donation._id }, { status: 'COMPLETED' });
  await QuantumMatchingAssignment.updateOne({ _id: d.assignment }, { assignmentStatus: 'COMPLETED' });
  await notifyMany([d.donation.donor, d.recipient._id], { type: 'completed', title: 'Donation delivered', body: `${d.donation.foodName} reached ${d.recipient.name}. Leave feedback?`, link: '/app/feedback' });
  broadcast(d);
  res.json(d);
}));

r.post('/:id/fail', authorize('DELIVERY', 'ADMIN'), validate([body('reason').trim().notEmpty().withMessage('Say what went wrong')]), asyncHandler(async (req, res) => {
  const d = await Delivery.findById(req.params.id).populate(POP);
  if (!d || (req.user.role === 'DELIVERY' && d.partner?._id.toString() !== req.user._id.toString())) throw new ApiError(404, 'Delivery not found');
  const before = d.status;
  if (before === 'ASSIGNED') {
    // Partner dropped out before pickup: reopen for another partner.
    d.partner = undefined; push(d, 'AWAITING_PARTNER', req.body.reason);
  } else {
    push(d, 'FAILED', req.body.reason); d.failureReason = req.body.reason;
    const don = await Donation.findById(d.donation._id);
    if (don && don.usableUntil > new Date() && before !== 'IN_TRANSIT') { don.status = 'AVAILABLE'; await don.save(); scheduleRematch('delivery failed'); }
    else if (don) { don.status = 'CANCELLED'; await don.save(); }
  }
  await d.save();
  await notifyMany([d.donation.donor, d.recipient._id], { type: 'delivery_issue', title: 'Delivery problem', body: req.body.reason, link: `/app/track/${d._id}` });
  broadcast(d);
  res.json(d);
}));

export default r;
