export const STATUS_RANK = {
  info: 0,
  pass: 1,
  warning: 2,
  fail: 3,
};

export function worstStatus(...statuses) {
  return statuses.reduce((highest, status) => {
    return STATUS_RANK[status] > STATUS_RANK[highest] ? status : highest;
  }, "pass");
}

export function countByStatus(items) {
  const counts = { pass: 0, warning: 0, fail: 0, info: 0 };

  for (const item of items) {
    if (counts[item.status] !== undefined) {
      counts[item.status] += 1;
    }
  }

  return counts;
}

// The single score formula for the whole app: severity-weighted deductions
// over item-level issues, floored at zero.
export function computeWeightedScore({ fail = 0, warning = 0, info = 0 }) {
  return Math.max(0, Math.round(100 - fail * 12 - warning * 4 - info * 1));
}
