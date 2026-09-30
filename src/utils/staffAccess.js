const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function partsInZone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = (get('weekday') || '').slice(0, 3).toLowerCase();
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return { day: weekday, minutes: Number(hour) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/**
 * Pure check: is a staff member allowed to be signed in right now, per the business's access rules?
 * Never called for ADMIN users — admins are unaffected by any of this.
 */
export function checkStaffAccess(business, now = new Date()) {
  const access = business?.staffAccess;
  if (!access) return { allowed: true };
  if (access.shutdown) return { allowed: false, reason: 'Staff access is currently turned off. Please try again later.' };
  if (!access.scheduleEnabled) return { allowed: true };

  let day, minutes;
  try {
    ({ day, minutes } = partsInZone(now, business.timezone || 'UTC'));
  } catch {
    return { allowed: true };
  }
  const dayIndex = DAY_KEYS.indexOf(day);
  if (dayIndex !== -1 && Array.isArray(access.days) && access.days[dayIndex] === false) {
    return { allowed: false, reason: 'Staff access is not available today. Please try again during business hours.' };
  }

  const start = toMinutes(access.start ?? '00:00');
  const end = toMinutes(access.end ?? '23:59');
  const withinWindow = start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
  if (!withinWindow) return { allowed: false, reason: 'Staff access is currently closed. Please try again during business hours.' };
  return { allowed: true };
}
