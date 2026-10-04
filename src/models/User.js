import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const ROLES = ['DONOR', 'NGO', 'BENEFICIARY', 'DELIVERY', 'ADMIN'];
export const PUBLIC_ROLES = ['DONOR', 'NGO', 'BENEFICIARY', 'DELIVERY'];
export const ACCOUNT_STATUS = ['ACTIVE', 'PENDING_VERIFICATION', 'REVIEW_REQUIRED', 'SUSPENDED', 'BLOCKED'];
export const VERIFICATION = ['PENDING', 'VERIFIED', 'REVIEW_REQUIRED', 'REJECTED', 'SUSPENDED'];

const pointSchema = new mongoose.Schema({
  type: { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
  role: { type: String, enum: ROLES, required: true },
  address: String,
  city: String,
  location: pointSchema,
  avatarUrl: String,
  accountStatus: { type: String, enum: ACCOUNT_STATUS, default: 'PENDING_VERIFICATION' },
  verificationStatus: { type: String, enum: VERIFICATION, default: 'PENDING' },
  emailVerified: { type: Boolean, default: false },
  phoneVerified: { type: Boolean, default: false },
  otp: { codeHash: { type: String, select: false }, expiresAt: Date, purpose: String, attempts: { type: Number, default: 0 } },
  riskScore: { type: Number, default: 0 },
  riskFlags: [String],
  // delivery partner
  available: { type: Boolean, default: false },
  vehicle: String,
  deliveryCapacity: { type: Number, default: 1 },
  lastLocationAt: Date,
  language: { type: String, default: 'en' },
  lastLogin: Date,
  failedLogins: { type: Number, default: 0 },
  lockUntil: Date,
}, { timestamps: true });

userSchema.index({ location: '2dsphere' });

userSchema.pre('save', async function hash(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
userSchema.methods.comparePassword = function compare(pw) { return bcrypt.compare(pw, this.password); };
userSchema.methods.toSafe = function toSafe() {
  const o = this.toObject();
  delete o.password; delete o.otp; delete o.failedLogins; delete o.lockUntil;
  return o;
};

export default mongoose.model('User', userSchema);
