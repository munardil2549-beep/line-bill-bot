// lib/parser.js
// แปลงข้อความผู้ใช้เป็นคำสั่งสรุป + ช่วงวันที่ + การจัดกลุ่ม และแปลข้อความแก้ไขฟิลด์

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// แปลงปี: พ.ศ.เต็ม -> ค.ศ., ปี 2 หลัก = พ.ศ.ย่อ (69 = 2569 = 2026)
function normYear(y) {
  let n = parseInt(y, 10);
  if (n < 100) n += 2500;   // 69 -> 2569
  if (n > 2400) n -= 543;   // พ.ศ. -> ค.ศ.
  return n;
}

// แปลงวันที่ d/m/y หรือ y-m-d -> YYYY-MM-DD
function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const y = normYear(m[3]);
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

// รอบบิล: 15 เดือนที่แล้ว -> 14 เดือนนี้
function billingCycle(now) {
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const to = new Date(now.getFullYear(), now.getMonth(), 14);
  return { from: ymd(from), to: ymd(to) };
}

function detectGroup(t) {
  if (/สาขา/.test(t)) return 'branch';
  if (/ขนส่ง|บริษัทขนส่ง/.test(t)) return 'courier';
  return null;
}

/**
 * คืน { type:'summary', from, to, groupBy } | { type:'help' } | { type:'recent' } | { type:'sheet' } | null
 */
function parseCommand(text, now = new Date()) {
  if (!text) return null;
  const t = text.trim();

  if (/^(help|ช่วยเหลือ|วิธีใช้|เมนู|menu|\?)$/i.test(t)) return { type: 'help' };
  if (/^(บิลล่าสุด|ล่าสุด|recent)/i.test(t)) return { type: 'recent' };
  if (/^(เปิดชีท|ชีท|sheet|ดาต้าเบส|database)/i.test(t)) return { type: 'sheet' };
  if (!/^(สรุป|รวมยอด|summary)/i.test(t)) return null;

  const groupBy = detectGroup(t);
  let from, to;
  if (/วันนี้|today/i.test(t)) {
    from = to = ymd(now);
  } else if (/เมื่อวาน|yesterday/i.test(t)) {
    const y = new Date(now); y.setDate(y.getDate() - 1); from = to = ymd(y);
  } else if (/รอบบิล|รอบ/.test(t)) {
    ({ from, to } = billingCycle(now));
  } else if (/เดือนนี้|this month/i.test(t)) {
    from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
    to = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  } else if (/เดือนที่แล้ว|last month/i.test(t)) {
    from = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    to = ymd(new Date(now.getFullYear(), now.getMonth(), 0));
  } else {
    const mDays = t.match(/(\d+)\s*วัน/);
    const dateRe = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/g;
    const dates = (t.match(dateRe) || []).map(parseDate).filter(Boolean).sort();
    if (dates.length >= 2) { from = dates[0]; to = dates[dates.length - 1]; }
    else if (dates.length === 1) { from = to = dates[0]; }
    else if (mDays) {
      const days = parseInt(mDays[1], 10);
      const s = new Date(now); s.setDate(s.getDate() - (days - 1));
      from = ymd(s); to = ymd(now);
    } else {
      // ค่าเริ่มต้น = รอบบิล 15->14
      ({ from, to } = billingCycle(now));
    }
  }
  return { type: 'summary', from, to, groupBy };
}

function toNum(v) {
  const n = parseFloat(String(v).replace(/[, ฿]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function normPayment(v) {
  if (/ปลายทาง/.test(v)) return 'เก็บปลายทาง';
  if (/ต้นทาง/.test(v)) return 'เก็บต้นทาง';
  if (/เครดิต|credit/i.test(v)) return 'เครดิต';
  return v.trim();
}

/**
 * แปลงข้อความแก้ไข เช่น "สาขา=ยะลา, ค่าขนส่ง=150, เจ้าของงาน=ซิลมี, บริษัทผ้า=Nava"
 */
function parseEdit(text) {
  const edits = {};
  const pairs = String(text).split(/[,\n]/);
  for (const p of pairs) {
    const idx = p.search(/[=:：]/);
    if (idx === -1) continue;
    const key = p.slice(0, idx).trim().toLowerCase();
    const val = p.slice(idx + 1).trim();
    if (!val) continue;
    if (/วันที่|date|^วัน$/.test(key)) edits.date = parseDate(val) || val;
    else if (/สาขา|ปลายทาง|branch/.test(key)) edits.branch = val;
    else if (/เจ้าของ|ชื่องาน|^งาน|owner|job/.test(key)) edits.job_owner = val;
    else if (/บริษัทผ้า|ยี่ห้อ|^ผ้า|fabric/.test(key)) edits.fabric_company = val;
    else if (/ค่าขนส่ง|ค่าส่ง|^ยอด|total|^รวม/.test(key)) edits.shipping_cost = toNum(val);
    else if (/ขนส่ง|courier/.test(key)) edits.courier = val;
    else if (/เลข/.test(key)) edits.bill_no = val;
    else if (/รายการ|สินค้า|item/.test(key)) edits.item = val;
    else if (/จำนวน|ชิ้น|qty/.test(key)) edits.qty = toNum(val);
    else if (/วิธี|เก็บเงิน|payment/.test(key)) edits.payment = normPayment(val);
  }
  return edits;
}

module.exports = { parseCommand, parseEdit, parseDate, ymd, billingCycle };
