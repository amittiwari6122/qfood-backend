import { Router } from 'express';
import { body } from 'express-validator';
import { Conversation, Message, Notification, Feedback } from '../models/Misc.js';
import Delivery from '../models/Delivery.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { isOnline, emitToRoom, emitToUser } from '../services/socket.js';
import { translate } from '../services/external.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
r.use(protect);

// ---- chat ---------------------------------------------------------------
r.get('/chat', asyncHandler(async (req, res) => {
  const convs = await Conversation.find({ participants: req.user._id }).populate('participants', 'name role avatarUrl')
    .populate('donation', 'foodName').sort('-lastMessageAt -createdAt').lean();
  for (const c of convs) {
    c.unread = await Message.countDocuments({ conversation: c._id, readBy: { $ne: req.user._id } });
    c.participants = c.participants.map((p) => ({ ...p, online: isOnline(p._id) }));
  }
  res.json(convs);
}));

r.post('/chat/:id/messages', asyncHandler(async (req, res) => {
  const c = await Conversation.findOne({ _id: req.params.id, participants: req.user._id });
  if (!c) throw new ApiError(404, 'Conversation not found');
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) throw new ApiError(400, 'Write a message first');
  const msg = await Message.create({ conversation: c._id, sender: req.user._id, text, readBy: [req.user._id] });
  c.lastMessageAt = new Date(); await c.save();
  const payload = { ...msg.toObject(), sender: { _id: req.user._id, name: req.user.name } };
  emitToRoom(`conv:${c._id}`, 'chat:message', payload);
  c.participants.filter((x) => x.toString() !== req.user._id.toString()).forEach((x) => emitToUser(x, 'chat:unread', { conversationId: c._id }));
  res.status(201).json(payload);
}));

r.get('/chat/:id/messages', asyncHandler(async (req, res) => {
  const c = await Conversation.findOne({ _id: req.params.id, participants: req.user._id });
  if (!c) throw new ApiError(404, 'Conversation not found');
  await Message.updateMany({ conversation: c._id, readBy: { $ne: req.user._id } }, { $addToSet: { readBy: req.user._id } });
  res.json(await Message.find({ conversation: c._id }).populate('sender', 'name').sort('createdAt').limit(300));
}));

r.post('/translate', validate([body('text').isString().isLength({ max: 2000 }), body('target').isIn(['en', 'hi', 'mr'])]),
  asyncHandler(async (req, res) => res.json(await translate(req.body.text, req.body.target))));

// ---- notifications ------------------------------------------------------
r.get('/notifications', asyncHandler(async (req, res) => {
  res.json(await Notification.find({ user: req.user._id }).sort('-createdAt').limit(50));
}));
r.post('/notifications/read', asyncHandler(async (req, res) => {
  const f = { user: req.user._id, ...(req.body.id ? { _id: req.body.id } : {}) };
  await Notification.updateMany(f, { read: true });
  res.json({ ok: true });
}));

// ---- feedback -----------------------------------------------------------
r.post('/feedback', validate([
  body('rating').isInt({ min: 1, max: 5 }), body('deliveryId').isMongoId(),
  body('foodCondition').optional().isIn(['GOOD', 'ACCEPTABLE', 'POOR', 'UNSAFE']), body('comment').optional().isLength({ max: 1000 }),
]), asyncHandler(async (req, res) => {
  const d = await Delivery.findById(req.body.deliveryId).populate('donation', 'donor');
  if (!d || d.status !== 'DELIVERED') throw new ApiError(400, 'You can leave feedback after delivery');
  const parties = [d.recipient, d.partner, d.donation.donor].map(String);
  if (!parties.includes(req.user._id.toString())) throw new ApiError(403, 'You were not part of this delivery');
  if (await Feedback.exists({ from: req.user._id, delivery: d._id })) throw new ApiError(409, 'You already left feedback for this delivery');
  const to = req.user._id.equals(d.donation.donor) ? d.recipient : d.donation.donor;
  const fb = await Feedback.create({ from: req.user._id, to, donation: d.donation._id, delivery: d._id, rating: req.body.rating,
    foodCondition: req.body.foodCondition, comment: req.body.comment, public: !!req.body.public });
  if (req.body.foodCondition === 'UNSAFE') {
    const User = (await import('../models/User.js')).default;
    await User.updateOne({ _id: d.donation.donor }, { verificationStatus: 'REVIEW_REQUIRED', $addToSet: { riskFlags: 'unsafe_food_report' } });
  }
  res.status(201).json(fb);
}));
r.get('/feedback/mine', asyncHandler(async (req, res) => {
  res.json(await Feedback.find({ $or: [{ from: req.user._id }, { to: req.user._id }] }).populate('from', 'name role').sort('-createdAt'));
}));

export default r;
