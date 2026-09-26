import { ApiError } from './ApiError.js';

const DAY = 86_400_000;

function partsIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** Offset in ms between `timeZone` wall-clock time and UTC at `date`. */
function offsetMs(date, timeZone) {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight for the given Y-M-D in `timeZone`. */
function zonedMidnight(y, m, d, timeZone) {
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

export function localDateKey(date, timeZone) {
  const p = partsIn(date, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function startOfDay(date, timeZone) {
  const p = partsIn(date, timeZone);
  return zonedMidnight(p.y, p.m, p.d, timeZone);
}

/**
 * Resolves a report range to UTC boundaries in the business time zone.
 * range: today | yesterday | 7d | 30d | month | year | custom (from/to as YYYY-MM-DD, inclusive)
 */
export function resolveRange({ range = '7d', from, to } = {}, timeZone = 'Africa/Lagos', now = new Date()) {
  const todayStart = startOfDay(now, timeZone);
  let start;
  let end = new Date(todayStart.getTime() + DAY);

  switch (range) {
    case 'today':
      start = todayStart;
      break;
    case 'yesterday':
      start = new Date(todayStart.getTime() - DAY);
      end = todayStart;
      break;
    case '7d':
      start = new Date(todayStart.getTime() - 6 * DAY);
      break;
    case '30d':
      start = new Date(todayStart.getTime() - 29 * DAY);
      break;
    case 'month': {
      const p = partsIn(now, timeZone);
      start = zonedMidnight(p.y, p.m, 1, timeZone);
      break;
    }
    case 'year': {
      const p = partsIn(now, timeZone);
      start = zonedMidnight(p.y, 1, 1, timeZone);
      break;
    }
    case 'custom': {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!re.test(from || '') || !re.test(to || '')) {
        throw ApiError.badRequest('Custom range needs from and to dates (YYYY-MM-DD).');
      }
      const [fy, fm, fd] = from.split('-').map(Number);
      const [ty, tm, td] = to.split('-').map(Number);
      start = zonedMidnight(fy, fm, fd, timeZone);
      end = new Date(zonedMidnight(ty, tm, td, timeZone).getTime() + DAY);
      if (end <= start) throw ApiError.badRequest('The end date must be on or after the start date.');
      if (end - start > 366 * DAY) throw ApiError.badRequest('Custom ranges can cover at most one year.');
      break;
    }
    default:
      throw ApiError.badRequest('Unknown range.');
  }

  const granularity = range === 'today' || range === 'yesterday' ? 'hour' : 'day';
  const buckets = [];
  if (granularity === 'day') {
    // Step by 25h then snap to local midnight so DST shifts never skip or repeat a day
    for (let t = start.getTime(); t < end.getTime(); ) {
      buckets.push(localDateKey(new Date(t), timeZone));
      t = startOfDay(new Date(t + 25 * 3_600_000), timeZone).getTime();
    }
  } else {
    for (let h = 0; h < 24; h++) buckets.push(String(h).padStart(2, '0'));
  }
  return { range, start, end, granularity, buckets, timeZone };
}
