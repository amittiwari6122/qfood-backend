import mongoose from 'mongoose';

const ngoSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  organizationName: { type: String, required: true },
  registrationNumber: { type: String, required: true },
  contactPerson: String,
  phone: String,
  email: String,
  address: String,
  operatingAreas: [String],
  foodRequirements: [String],
  vegOnly: { type: Boolean, default: false },
  documents: [{ url: String, name: String, uploadedAt: { type: Date, default: Date.now } }],
  verificationStatus: { type: String, enum: ['PENDING', 'VERIFIED', 'REVIEW_REQUIRED', 'REJECTED', 'SUSPENDED'], default: 'PENDING' },
  verificationNotes: String,
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
}, { timestamps: true });

export default mongoose.model('NgoProfile', ngoSchema);
