/** Runs every minute: expires food, warns on near-expiry, releases stale matches. */
import cron from 'node-cron';
import Donation from '../models/Donation.js';
import FoodRequest from '../models/FoodRequest.js';
import { QuantumMatchingAssignment } from '../models/Quantum.js';
import Waste from '../models/Waste.js';
import User from '../models/User.js';
import { notify, notifyMany } from '../services/notify.js';
import { scheduleRematch } from '../services/quantum.js';

const MATCH_TIMEOUT_MIN = +process.env.MATCH_ACCEPT_TIMEOUT_MIN || 20;
const warned = new Set();

export async function expirySweep() {
  const now = new Date();
  const expiring = await Donation.find({ status: { $in: ['AVAILABLE', 'PENDING_REVIEW', 'MATCHED'] }, usableUntil: { $lte: now } });
  for (const d of expiring) {
    const wasMatched = d.status === 'MATCHED';
    d.status = 'EXPIRED';
    await d.save();
    await QuantumMatchingAssignment.updateMany({ donationId: d._id, assignmentStatus: 'PROPOSED' }, { assignmentStatus: 'SUPERSEDED' });
    // Unmatched food is not thrown away: it is routed to waste management (compost / biogas / animal feed).
    const method = d.isVeg === false ? 'BIOGAS' : 'COMPOST';
    const created = await Waste.updateOne({ donation: d._id }, { $setOnInsert: {
      donation: d._id, donor: d.donor, foodName: d.foodName, quantity: d.quantity, unit: d.unit, isVeg: d.isVeg, method,
      address: d.address, lat: d.location?.coordinates?.[1], lng: d.location?.coordinates?.[0] } }, { upsert: true });
    await notify(d.donor, { type: 'expired', title: 'Sent to waste management', body: `${d.foodName} could not be matched in time, so it was sent to a waste-management partner (${method.replace('_', ' ').toLowerCase()}).`, link: '/app/waste' });
    if (created.upsertedCount) {
      const partners = await User.find({ role: 'WASTE_PARTNER', accountStatus: 'ACTIVE' }).select('_id').limit(100);
      if (partners.length) await notifyMany(partners.map((x) => x._id), { type: 'waste', title: 'New waste pickup', body: `${d.foodName} (${d.quantity} ${d.unit}) needs collection.`, link: '/app/waste' });
    }
    if (wasMatched && d.matchedNgo) await notify(d.matchedNgo, { type: 'expired', title: 'Matched food expired', body: d.foodName });
  }

  // Near-expiry: warn once and push into an urgent rematch
  const soon = await Donation.find({ status: 'AVAILABLE', usableUntil: { $gt: now, $lte: new Date(now.getTime() + 60 * 60000) } });
  let urgent = false;
  for (const d of soon) {
    if (warned.has(d.id)) continue;
    warned.add(d.id); urgent = true;
    await notify(d.donor, { type: 'expiring', title: 'Food expiring within an hour', body: `${d.foodName} is still unmatched. We're prioritising it.` });
  }

  // Matches not accepted in time go back to the pool
  const stale = await QuantumMatchingAssignment.find({ assignmentStatus: 'PROPOSED', createdAt: { $lte: new Date(now.getTime() - MATCH_TIMEOUT_MIN * 60000) } });
  for (const a of stale) {
    a.assignmentStatus = 'SUPERSEDED'; await a.save();
    await Donation.updateOne({ _id: a.donationId, status: 'MATCHED' }, { status: 'AVAILABLE', $unset: { matchedNgo: 1, matchedRequest: 1 } });
  }

  await FoodRequest.updateMany({ status: { $in: ['OPEN', 'PARTIALLY_FULFILLED'] }, requiredBefore: { $lte: now } }, { status: 'EXPIRED' });
  if (expiring.length || urgent || stale.length) scheduleRematch([expiring.length && 'food expired', urgent && 'food approaching expiry', stale.length && 'match not accepted in time'].filter(Boolean).join(', '));
}

export const startJobs = () => cron.schedule('* * * * *', () => expirySweep().catch((e) => console.error('[expiry]', e.message)));
