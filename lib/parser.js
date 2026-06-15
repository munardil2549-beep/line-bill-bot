// lib/parser.js
// แปลงข้อความผู้ใช้เป็นคำสั่งสรุปยอด + ช่วงวันที่

// คืนค่า YYYY-MM-DD จาก Date (อิงเวลาท้องถิ่นของ process; ตั้ง TZ=Asia/Bangkok)
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// แปลงปี พ.ศ. -> ค.ศ. ถ้าจำเป็น
function normYear(y) {
  let n = parseInt(y, 10);
  if (n > 2400) n -= 543; // พ.ศ.
  else if (n < 100) n += 2000; // เช่น 26 -> 2026
  return n;
}

// แปลงวันที่รูปแบบ d/m/y หรือ y-m-d เป็น YYYY-MM-DD
function parseDate(str) {
  str = str.trim();
  let m;
  // YYYY-MM-DD
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  // d/m/y หรือ d-m-y หรือ d.m.y
  m = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const y = normYear(m[3]);
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

/**
 * แปลงข้อความเป็นคำสั่ง
 * คืน { type: 'summary', from, to } | { type: 'help' } | null
 */
function parseCommand(text, now = new Date()) {
  if (!text) return null;
  const t = text.trim();
  const lower = t.toLowerCase();

  if (/^(help|ช่วยเหลือ|วิธีใช้|เมนู|menu|\?)$/i.test(t)) {
    return { type: 'help' };
  }

  // ต้องขึ้นต้นด้วยคำว่า สรุป / summary / สรุปยอด
  if (!/^(สรุป|summary)/i.test(t)) {
    return null;
  }

  // สรุปวันนี้
  if (/วันนี้|today/i.test(lower)) {
    const d = ymd(now);
    return { type: 'summary', from: d, to: d };
  }
  // สรุปเมื่อวาน
  if (/เมื่อวาน|yesterday/i.test(lower)) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const d = ymd(y);
    return { type: 'summary', from: d, to: d };
  }
  // สรุปเดือนนี้
  if (/เดือนนี้|this month/i.test(lower)) {
    const from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
    const to = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    return { type: 'summary', from, to };
  }
  // สรุปเดือนที่แล้ว
  if (/เดือนที่แล้ว|last month/i.test(lower)) {
    const from = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const to = ymd(new Date(now.getFullYear(), now.getMonth(), 0));
    return { type: 'summary', from, to };
  }
  // สรุป 7 วัน / สรุป N วัน
  let m = t.match(/(\d+)\s*วัน/);
  if (m) {
    const days = parseInt(m[1], 10);
    const start = new Date(now);
    start.setDate(start.getDate() - (days - 1));
    return { type: 'summary', from: ymd(start), to: ymd(now) };
  }

  // หาวันที่ทั้งหมดในข้อความ
  const dateRe = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/g;
  const found = t.match(dateRe) || [];
  const dates = found.map(parseDate).filter(Boolean).sort();
  if (dates.length >= 2) {
    return { type: 'summary', from: dates[0], to: dates[dates.length - 1] };
  }
  if (dates.length === 1) {
    return { type: 'summary', from: dates[0], to: dates[0] };
  }

  // สรุปเฉยๆ = เดือนนี้
  const from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  return { type: 'summary', from, to };
}

/**
 * แปลงข้อความแก้ไข เช่น "ร้าน=7-11, ยอด=120, วันที่=2026-06-10, หมวด=อาหาร"
 * คืน object ของ field ที่ต้องการแก้
 */
function parseEdit(text) {
  const edits = {};
  const pairs = text.split(/[,\n]/);
  for (const p of pairs) {
    const m = p.split(/[=:：]/);
    if (m.length < 2) continue;
    const key = m[0].trim().toLowerCase();
    const val = m.slice(1).join('=').trim();
    if (/ร้าน|store|shop/.test(key)) edits.store = val;
    else if (/ยอดรวม|ยอด|total|รวม/.test(key)) edits.total = parseFloat(val.replace(/[, ฿]/g, ''));
    else if (/วันที่|date|วัน/.test(key)) edits.date = parseDate(val) || val;
    else if (/หมวด|category|ประเภท/.test(key)) edits.category = val;
    else if (/vat|ภาษี/.test(key)) edits.vat = parseFloat(val.replace(/[, ฿]/g, ''));
  }
  return edits;
}

module.exports = { parseCommand, parseEdit, parseDate, ymd };
