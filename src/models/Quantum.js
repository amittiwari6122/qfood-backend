import mongoose from 'mongoose';

const runSchema = new mongoose.Schema({
  runId: { type: String, unique: true, index: true },
  algorithm: { type: String, default: 'QAOA' },
  executionMode: String,
  backend: String,
  trigger: String,
  triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  numberOfDonations: Number,
  numberOfRequests: Number,
  possibleAssignments: Number,
  numberOfVariables: Number,
  numberOfConstraints: Number,
  objectiveValue: Number,
  executionTime: Number,
  status: { type: String, enum: ['RUNNING', 'success', 'no_feasible', 'FAILED'], default: 'RUNNING' },
  valid: Boolean,
  message: String,
  assignments: [mongoose.Schema.Types.Mixed],
  batches: [mongoose.Schema.Types.Mixed],
  decomposition: mongoose.Schema.Types.Mixed,
  pruned: [mongoose.Schema.Types.Mixed],
  visualization: mongoose.Schema.Types.Mixed,
  error: String,
}, { timestamps: true });

const assignmentSchema = new mongoose.Schema({
  runId: { type: String, index: true },
  donationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Donation', index: true },
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRequest' },
  ngoId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  quantity: Number,
  distance: Number,
  foodQuality: Number,
  freshness: Number,
  urgency: Number,
  deliveryTime: Number,
  netBenefit: Number,
  assignmentStatus: { type: String, enum: ['PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'COMPLETED'], default: 'PROPOSED' },
}, { timestamps: true });

export const QuantumMatchingRun = mongoose.model('QuantumMatchingRun', runSchema);
export const QuantumMatchingAssignment = mongoose.model('QuantumMatchingAssignment', assignmentSchema);
