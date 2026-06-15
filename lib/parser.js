// lib/parser.js
// แปลงข้อความผู้ใช้เป็นคำสั่งสรุป + ช่วงวันที่ + การจัดกลุ่ม และแปลข้อความแก้ไขฟิลด์

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normYear(y) {
  let n = parseInt(y, 10);
  if (n > 2400) n -= 543;      // พ.ศ. เต็ม
  else if (n < 100) n += 2000; // 2 หลัก -> 20xx
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

// ตรวจคำจัดกลุ่มในข้อความ
function detectGroup(t) {
  if (/สาขา/.test(t)) return 'branch';
  if (/ขนส่ง|บริษัท/.test(t)) return 'courier';
  return null;
}

/**
 * แปลงข้อความเป็นคำสั่ง
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

  // ช่วงเวลา
  let from, to;
  if (/วันนี้|today/i.test(t)) {
    from = to = ymd(now);
  } else if (/เมื่อวาน|yesterday/i.test(t)) {
    const y = new Date(now); y.setDate(y.getDate() - 1); from = to = ymd(y);
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
      // ไม่ระบุช่วง -> เดือนนี้
      from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
      to = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
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
 * แปลงข้อความแก้ไข เช่น "สาขา=ยะลา, ค่าขนส่ง=150, เจ้าของงาน=ซิลมี"
 * คืน object ของ field ที่ต้องการแก้
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
    else if (/เจ้าของ|owner/.test(key)) edits.job_owner = val;
    else if (/ชื่องาน|^งาน|job/.test(key)) edits.job_name = val;
    else if (/ค่าขนส่ง|ค่าส่ง|^ยอด|total|^รวม/.test(key)) edits.shipping_cost = toNum(val);
    else if (/บริษัท|ขนส่ง|courier/.test(key)) edits.courier = val;
    else if (/เลข/.test(key)) edits.bill_no = val;
    else if (/รายการ|สินค้า|item/.test(key)) edits.item = val;
    else if (/จำนวน|ชิ้น|qty/.test(key)) edits.qty = toNum(val);
    else if (/วิธี|เก็บเงิน|payment/.test(key)) edits.payment = normPayment(val);
  }
  return edits;
}

module.exports = { parseCommand, parseEdit, parseDate, ymd };
