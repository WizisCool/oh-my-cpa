import { getTimeZone } from '../../utils/time';

const PARTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

let formatterZone = '';
let formatter: Intl.DateTimeFormat | undefined;

// One formatter per display zone, reused for every row. Constructing a zoned date
// per row resolves the zone again each time, and a scrolling request list formats
// a timestamp for every row it mounts.
function zoneFormatter(): Intl.DateTimeFormat {
  const zone = getTimeZone();
  if (!formatter || formatterZone !== zone) {
    formatter = new Intl.DateTimeFormat('en-US', { ...PARTS, timeZone: zone });
    formatterZone = zone;
  }
  return formatter;
}

export function formatRequestTimestamp(timestamp: number): { shortTime: string; fullTime: string } {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of zoneFormatter().formatToParts(timestamp)) parts[part.type] = part.value;
  const shortTime = `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  // No zone offset has a sub-second part, so the fraction is the instant's own;
  // the double modulo keeps it positive before the epoch.
  const milliseconds = ((Math.trunc(timestamp) % 1000) + 1000) % 1000;
  return {
    shortTime,
    fullTime: `${parts.year}-${shortTime}.${String(milliseconds).padStart(3, '0')}`,
  };
}
