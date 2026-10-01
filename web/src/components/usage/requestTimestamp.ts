import dayjs from '../../utils/time';

/** Both row labels describe the same instant, so resolve its display zone only once. */
export function formatRequestTimestamp(timestamp: number): { shortTime: string; fullTime: string } {
  const date = dayjs(timestamp);
  return {
    shortTime: date.format('MM-DD HH:mm:ss'),
    fullTime: date.format('YYYY-MM-DD HH:mm:ss.SSS'),
  };
}
