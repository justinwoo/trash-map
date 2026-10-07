// Downloads 臺北市垃圾車點位路線資訊 from data.taipei and writes a compact
// snapshot to public/stops.json. The API sends no CORS headers for other
// origins, so the browser cannot call it directly.
import { mkdir, writeFile } from 'node:fs/promises';

const RID = 'a6e90031-7ec4-4089-afb5-361a4efe7202';
const API = `https://data.taipei/api/v1/dataset/${RID}?scope=resourceAquire`;
const PAGE = 1000;

async function fetchPage(offset) {
  const res = await fetch(`${API}&limit=${PAGE}&offset=${offset}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${offset}`);
  return (await res.json()).result;
}

const first = await fetchPage(0);
const total = first.count;
const rows = [...first.results];
while (rows.length < total) {
  const page = await fetchPage(rows.length);
  if (page.count !== total) throw new Error('total changed mid-download; rerun');
  if (page.results.length === 0) break;
  rows.push(...page.results);
}
if (new Set(rows.map((r) => r._id)).size !== total) {
  throw new Error(`expected ${total} unique rows, got ${rows.length}`);
}

const hhmm = (s) => `${s.slice(0, 2)}:${s.slice(2, 4)}`;

// A few addresses carry day restrictions, e.g. "(週一、週五收運)" or
// "(週二、週五無收運)". Returns served weekdays (0 = Sun) or null for the
// normal Mon/Tue/Thu/Fri/Sat schedule. Notes about 回收車 only are ignored.
const DAY_CHARS = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const NORMAL_DAYS = [1, 2, 4, 5, 6];
function parseDays(address) {
  for (const [, note] of address.matchAll(/[（(]([^()（）]*)[)）]/g)) {
    if (!/[週星]/.test(note) || note.includes('回收車')) continue;
    const days = [...note.replace(/星期|週/g, ' ').matchAll(/[日一二三四五六]/g)].map(
      (m) => DAY_CHARS[m[0]],
    );
    if (!days.length) continue;
    return note.includes('無') ? NORMAL_DAYS.filter((d) => !days.includes(d)) : days;
  }
  return null;
}
let skipped = 0;
const stops = [];
for (const r of rows) {
  const lng = Number(r['經度']);
  const lat = Number(r['緯度']);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < 121 || lat < 24.9) {
    skipped++;
    continue;
  }
  stops.push({
    id: r._id,
    district: r['行政區'],
    village: r['里別'],
    team: r['分隊'],
    car: r['車號'],
    route: r['路線'],
    trip: r['車次'],
    arrive: hhmm(r['抵達時間'].padStart(4, '0')),
    leave: hhmm(r['離開時間'].padStart(4, '0')),
    address: r['地點'],
    days: parseDays(r['地點']),
    lng,
    lat,
  });
}

const importedAt = first.results[0]?._importdate?.date?.slice(0, 19) ?? null;
await mkdir('public', { recursive: true });
await writeFile(
  'public/stops.json',
  JSON.stringify({ fetchedAt: new Date().toISOString(), importedAt, stops }),
);
console.log(`wrote ${stops.length} stops (skipped ${skipped} without valid coords)`);
