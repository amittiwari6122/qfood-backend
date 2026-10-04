import mongoose from 'mongoose';
const { ObjectId, Mixed } = mongoose.Schema.Types;

export const Notification = mongoose.model('Notification', new mongoose.Schema({
  user: { type: ObjectId, ref: 'User', index: true },
  type: String,
  title: String,
  body: String,
  link: String,
  data: Mixed,
  read: { type: Boolean, default: false },
}, { timestamps: true }));

export const Conversation = mongoose.model('Conversation', new mongoose.Schema({
  participants: [{ type: ObjectId, ref: 'User', index: true }],
  donation: { type: ObjectId, ref: 'Donation' },
  delivery: { type: ObjectId, ref: 'Delivery' },
  lastMessageAt: Date,
}, { timestamps: true }));

export const Message = mongoose.model('Message', new mongoose.Schema({
  conversation: { type: ObjectId, ref: 'Conversation', index: true },
  sender: { type: ObjectId, ref: 'User' },
  text: { type: String, maxlength: 2000 },
  readBy: [{ type: ObjectId, ref: 'User' }],
}, { timestamps: true }));

export const Feedback = mongoose.model('Feedback', new mongoose.Schema({
  from: { type: ObjectId, ref: 'User', required: true },
  to: { type: ObjectId, ref: 'User' },
  donation: { type: ObjectId, ref: 'Donation' },
  delivery: { type: ObjectId, ref: 'Delivery' },
  rating: { type: Number, min: 1, max: 5, required: true },
  foodCondition: { type: String, enum: ['GOOD', 'ACCEPTABLE', 'POOR', 'UNSAFE'] },
  comment: { type: String, maxlength: 1000 },
  public: { type: Boolean, default: false },
}, { timestamps: true }));

export const AuditLog = mongoose.model('AuditLog', new mongoose.Schema({
  actor: { type: ObjectId, ref: 'User' },
  action: String,
  entity: String,
  entityId: String,
  meta: Mixed,
  ip: String,
}, { timestamps: true }));

export const Order = mongoose.model('Order', new mongoose.Schema({
  buyer: { type: ObjectId, ref: 'User', required: true },
  donation: { type: ObjectId, ref: 'Donation', required: true },
  quantity: Number,
  amount: Number,
  currency: { type: String, default: 'INR' },
  provider: String,
  providerOrderId: String,
  status: { type: String, enum: ['CREATED', 'PAID', 'PAY_AT_PICKUP', 'FAILED', 'CANCELLED'], default: 'CREATED' },
}, { timestamps: true }));
