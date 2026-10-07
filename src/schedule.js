// Taipei collection rules (臺北市垃圾不落地): trucks run five days a week.
// Wednesday and Sunday have no collection. Recycling alternates by day;
// food waste (廚餘) is taken on every collection day.
const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PAPER = { zh: '回收：紙類', en: 'Recycling: paper' };
const OTHER = { zh: '回收：其他類（塑膠、鐵鋁罐、玻璃）', en: 'Recycling: plastic, cans, glass' };
const RECYCLING = { 0: null, 1: PAPER, 2: OTHER, 3: null, 4: OTHER, 5: PAPER, 6: OTHER };

// Arabic weekday numbers, Sunday as 7: 週4 = Thursday.
const dayNum = (weekday) => weekday || 7;

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Current weekday and minutes since midnight in Taipei, independent of the device timezone.
function taipeiNow(date = new Date()) {
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: WEEKDAY[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function dayInfo(weekday) {
  return {
    label: `週${dayNum(weekday)}`,
    labelEn: DAY_EN[weekday],
    collecting: RECYCLING[weekday] !== null,
    recycling: RECYCLING[weekday],
  };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Data uses 24:xx for stops after midnight.
function formatMinutes(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
