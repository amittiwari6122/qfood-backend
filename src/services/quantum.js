/**
 * Quantum Matching orchestration (Node side).
 * Gathers eligible donations / requests / partners from MongoDB, calls the
 * Python QAOA service, persists the run + assignments, and notifies users.
 * Re-matching is debounced so a burst of triggers produces one fresh run.
 */
import crypto from 'crypto';
import env from '../config/env.js';
import Donation from '../models/Donation.js';
import FoodRequest from '../models/FoodRequest.js';
import User from '../models/User.js';
import NgoProfile from '../models/NgoProfile.js';
import { QuantumMatchingRun, QuantumMatchingAssignment } from '../models/Quantum.js';
import { isMatchable } from './safety.js';
import { notify } from './notify.js';
import { getIO, emitToRole } from './socket.js';

let running = false;
let timer = null;
let pendingReasons = new Set();

export async function quantumHealth() {
  try {
    const r = await fetch(`${env.quantumUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return { reachable: r.ok, ...(await r.json()) };
  } catch (e) { return { reachable: false, error: `Quantum service unreachable at ${env.quantumUrl}` }; }
}

export async function buildProblem() {
  const now = new Date();
  const donations = await Donation.find({ status: 'AVAILABLE', usableUntil: { $gt: now } }).populate('donor', 'accountStatus verificationStatus');
  const eligible = donations.filter((d) => isMatchable(d, d.donor, now));

  const requests = await FoodRequest.find({ status: { $in: ['OPEN', 'PARTIALLY_FULFILLED'] }, requiredBefore: { $gt: now } })
    .populate('requester', 'accountStatus verificationStatus role');
  const ngoProfiles = await NgoProfile.find({ user: { $in: requests.map((r) => r.requester?._id) } }).select('user verificationStatus vegOnly');
  const ngoVerified = new Map(ngoProfiles.map((p) => [p.user.toString(), p]));
  const liveRequests = requests.filter((r) => r.requester && r.requester.accountStatus === 'ACTIVE');

  const partners = await User.find({ role: 'DELIVERY', available: true, accountStatus: 'ACTIVE', verificationStatus: 'VERIFIED' }).select('deliveryCapacity location');
  const activeLoads = await import('../models/Delivery.js').then(({ default: D }) =>
    D.aggregate([{ $match: { status: { $in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } } }, { $group: { _id: '$partner', n: { $sum: 1 } } }]));
  const load = new Map(activeLoads.map((a) => [String(a._id), a.n]));

  const excludedPairs = [];
  for (const d of eligible) for (const r of liveRequests) if (d.rejectedBy?.some((u) => u.toString() === r.requester._id.toString())) excludedPairs.push(`${d._id}|${r._id}`);

  const remainingQty = (r) => Math.max(1, r.quantity - (r.fulfilledQuantity || 0));
  return {
    donations: eligible.map((d) => ({
      id: d._id.toString(), lat: d.location.coordinates[1], lng: d.location.coordinates[0],
      quantity: d.quantity, category: d.category, isVeg: d.isVeg,
      qualityScore: d.ai?.qualityScore ?? (d.manualReview?.status === 'APPROVED' ? 75 : null),
      aiStatus: d.ai?.status, preparedAt: d.preparedAt, usableUntil: d.usableUntil, pickupEnd: d.pickupEnd,
      donorVerified: d.donor?.verificationStatus === 'VERIFIED', status: d.status,
    })),
    requests: liveRequests.map((r) => {
      const prof = ngoVerified.get(r.requester._id.toString());
      const verified = r.requesterRole === 'NGO' ? prof?.verificationStatus === 'VERIFIED' : r.requester.verificationStatus === 'VERIFIED';
      return { id: r._id.toString(), ngoId: r.requester._id.toString(), lat: r.location.coordinates[1], lng: r.location.coordinates[0],
        quantity: remainingQty(r), categories: r.categories, beneficiaries: r.beneficiaries, priority: r.priority,
        requiredBefore: r.requiredBefore, vegOnly: r.vegOnly || prof?.vegOnly || false, ngoVerified: verified };
    }),
    // If no real delivery partner exists yet, use one virtual partner so matching is never blocked.
    deliveryPartners: (() => {
      const real = partners.map((p) => ({ id: p._id.toString(), available: true,
        capacity: Math.max(0, (p.deliveryCapacity || 1) - (load.get(p._id.toString()) || 0)) })).filter((p) => p.capacity > 0);
      return real.length ? real : [{ id: 'virtual-partner', available: true, capacity: Math.max(1, eligible.length) }];
    })(),
    // Relaxed rules for quick matching: nearby (<=100 km) is enough, no verification/quality gates.
    constraints: { excludedPairs, executionMode: env.quantumMode, requireVerified: false, maxDistanceKm: 100,
      minQualityScore: 0, restarts: 1, maxIter: 80 },
  };
}

const toRad = (x) => (x * Math.PI) / 180;
const km = (a, b) => {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/** Classical fallback used ONLY when the QAOA service fails: pairs each donation with the open
 *  request whose needed quantity is closest to it (ties: nearest). Clearly labelled as non-quantum. */
function quantityFallback(problem, reason) {
  const t0 = Date.now();
  const usedReq = new Set();
  const assignments = [];
  for (const d of [...problem.donations].sort((a, b) => b.quantity - a.quantity)) {
    let best = null;
    for (const r of problem.requests) {
      if (usedReq.has(r.id)) continue;
      if (d.isVeg === false && r.vegOnly) continue;
      const diff = Math.abs(r.quantity - d.quantity);
      const dist = km(d, r);
      if (!best || diff < best.diff || (diff === best.diff && dist < best.dist)) best = { r, diff, dist };
    }
    if (!best) continue;
    usedReq.add(best.r.id);
    assignments.push({ donationId: d.id, requestId: best.r.id, ngoId: best.r.ngoId, quantity: Math.min(d.quantity, best.r.quantity),
      distanceKm: best.dist, foodQuality: 0.6, freshness: 0.5, urgency: 0.3, deliveryMinutes: Math.round(best.dist / 20 * 60 + 15), netBenefit: 1 });
  }
  return { assignments, executionMode: 'classical-fallback', backend: 'quantity-matching (QAOA unavailable)', numberOfVariables: assignments.length,
    numberOfConstraints: 0, objectiveValue: null, executionTime: (Date.now() - t0) / 1000, batches: [], decomposition: null, pruned: [], visualization: undefined,
    note: `Quantum solver unavailable (${reason}). Matched by food quantity instead.` };
}

export async function runMatching({ trigger = 'manual', userId } = {}) {
  if (running) { scheduleRematch('queued while running'); return { status: 'queued' }; }
  running = true;
  const runId = crypto.randomUUID();
  const io = getIO();
  try {
    const problem = await buildProblem();
    const run = await QuantumMatchingRun.create({ runId, trigger, triggeredBy: userId, status: 'RUNNING',
      executionMode: env.quantumMode, numberOfDonations: problem.donations.length, numberOfRequests: problem.requests.length,
      possibleAssignments: problem.donations.length * problem.requests.length });
    io?.emit('quantum:status', { runId, stage: 'building_qubo', donations: problem.donations.length, requests: problem.requests.length });

    if (!problem.donations.length || !problem.requests.length) {
      Object.assign(run, { status: 'no_feasible', valid: false, message: 'No eligible donations or open requests to match.', executionTime: 0 });
      await run.save();
      io?.emit('quantum:status', { runId, stage: 'done', status: run.status, message: run.message });
      return run;
    }

    io?.emit('quantum:status', { runId, stage: 'running_qaoa' });
    let out;
    try {
      const res = await fetch(`${env.quantumUrl}/quantum/solve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, ...problem }), signal: AbortSignal.timeout(150 * 1000),
      });
      out = await res.json();
      if (!res.ok) throw new Error(out.detail || 'Quantum service error');
      if (!out.assignments?.length) throw new Error('QAOA found no feasible assignment');
    } catch (qe) {
      // Honest fallback: the quantum solver was unavailable, so match by food quantity and say so.
      console.error('[quantum] QAOA unavailable, using quantity-based fallback:', qe.message);
      out = quantityFallback(problem, qe.message);
    }

    io?.emit('quantum:status', { runId, stage: 'validating' });
    // Re-check against the *current* DB state: data may have changed while QAOA ran.
    const fresh = await Donation.find({ _id: { $in: out.assignments.map((a) => a.donationId) } }).populate('donor');
    const freshMap = new Map(fresh.map((d) => [d._id.toString(), d]));
    const accepted = out.assignments.filter((a) => isMatchable(freshMap.get(a.donationId), freshMap.get(a.donationId)?.donor));

    await QuantumMatchingAssignment.updateMany({ donationId: { $in: accepted.map((a) => a.donationId) }, assignmentStatus: 'PROPOSED' }, { assignmentStatus: 'SUPERSEDED' });
    for (const a of accepted) {
      await QuantumMatchingAssignment.create({ runId, donationId: a.donationId, requestId: a.requestId, ngoId: a.ngoId,
        quantity: a.quantity, distance: a.distanceKm, foodQuality: a.foodQuality, freshness: a.freshness, urgency: a.urgency,
        deliveryTime: a.deliveryMinutes, netBenefit: a.netBenefit });
      const d = freshMap.get(a.donationId);
      Object.assign(d, { status: 'MATCHED', matchedRequest: a.requestId, matchedNgo: a.ngoId, matchRunId: runId });
      await d.save();
      await notify(a.ngoId, { type: 'quantum_match', title: 'Quantum match found',
        body: `${d.quantity} ${d.unit} of ${d.foodName}, ${a.distanceKm.toFixed(1)} km away. Accept before it expires.`, link: '/app/matches', data: { donationId: a.donationId, runId } });
      await notify(d.donor._id, { type: 'quantum_match', title: 'Your donation was matched',
        body: `${d.foodName} matched to an NGO ${a.distanceKm.toFixed(1)} km away. Waiting for acceptance.`, link: '/app/donations' });
    }

    const ngoNames = new Map((await User.find({ _id: { $in: accepted.map((a) => a.ngoId) } }).select('name')).map((u) => [u._id.toString(), u.name]));
    for (const a of accepted) { const d = freshMap.get(a.donationId); a.foodName = d.foodName; a.unit = d.unit; a.ngoName = ngoNames.get(a.ngoId); a.usableUntil = d.usableUntil; }
    Object.assign(run, { status: accepted.length ? 'success' : 'no_feasible', valid: accepted.length > 0,
      executionMode: out.executionMode, backend: out.backend, numberOfVariables: out.numberOfVariables,
      numberOfConstraints: out.numberOfConstraints, objectiveValue: out.objectiveValue, executionTime: out.executionTime,
      assignments: accepted, batches: out.batches, decomposition: out.decomposition, pruned: out.pruned?.slice(0, 300),
      visualization: out.visualization, message: accepted.length ? (out.note || null) : 'No feasible quantum matching found.' });
    await run.save();
    io?.emit('quantum:status', { runId, stage: 'done', status: run.status, matches: accepted.length });
    emitToRole('ADMIN', 'quantum:run', { runId });
    return run;
  } catch (e) {
    await QuantumMatchingRun.updateOne({ runId }, { status: 'FAILED', error: e.message, valid: false });
    io?.emit('quantum:status', { runId, stage: 'done', status: 'FAILED', message: e.message });
    throw e;
  } finally {
    running = false;
  }
}

/** Debounced re-match. Triggers: NGO reject, partner unavailable, quantity/request
 *  change, urgency, approaching expiry, cancellation, failed delivery, new data. */
export function scheduleRematch(reason) {
  if (!env.quantumAutoMatch) return;
  pendingReasons.add(reason);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const trigger = [...pendingReasons].join(', ');
    pendingReasons = new Set();
    runMatching({ trigger }).catch((e) => console.error('[quantum] auto-match failed:', e.message));
  }, env.quantumDebounceMs);
}
export const isRunning = () => running;
