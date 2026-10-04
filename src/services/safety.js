/** Backend food-safety rules. AI is advisory; these rules decide eligibility. */
const MAX_HOURS = { room_temp: 6, hot_holding: 4, refrigerated: 48, frozen: 24 * 30 };

export function evaluateDonation(d, now = new Date()) {
  const reasons = [];
  const usable = new Date(d.usableUntil);
  if (usable <= now) reasons.push('Usable-until time has passed');
  if (new Date(d.preparedAt) > now) reasons.push('Preparation time is in the future');
  if (usable <= new Date(d.preparedAt)) reasons.push('Usable-until must be after preparation time');
  const hours = (usable - new Date(d.preparedAt)) / 36e5;
  const limit = MAX_HOURS[d.storageCondition] ?? 6;
  if (d.category === 'cooked' && hours > limit) reasons.push(`Cooked food stored ${d.storageCondition.replace('_', ' ')} is limited to ${limit}h from preparation`);
  if (new Date(d.pickupEnd) <= new Date(d.pickupStart)) reasons.push('Pickup end must be after pickup start');
  if (new Date(d.pickupStart) > usable) reasons.push('Pickup must start before food expires');
  return { ok: reasons.length === 0, reasons };
}

/** Is this donation eligible to enter quantum matching right now? */
export function isMatchable(d, donor, now = new Date()) {
  if (d.status !== 'AVAILABLE') return false;
  if (new Date(d.usableUntil) <= now) return false;
  if (d.ai?.status === 'UNSAFE') return false;
  const aiOk = ['SAFE', 'CAUTION'].includes(d.ai?.status);
  if (!aiOk && d.manualReview?.status !== 'APPROVED') return false;
  if (donor && ['SUSPENDED', 'BLOCKED'].includes(donor.accountStatus)) return false;
  if (donor && ['SUSPENDED', 'REJECTED'].includes(donor.verificationStatus)) return false;
  return true;
}
