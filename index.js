// index.js — LINE bot บันทึกค่าขนส่ง: อ่านบิล → ยืนยัน/แก้ไข(ฟอร์ม LIFF) → ชีท → สรุปแยกสาขา
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const line = require('@line/bot-sdk');

const { readBill } = require('./lib/reader');
const sheets = require('./lib/sheets');
const { parseCommand, parseEdit } = require('./lib/parser');
const upload = require('./lib/upload');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const LIFF_ID = process.env.LIFF_ID || '';
const VIEW_PASSCODE = process.env.VIEW_PASSCODE || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
function dataUrl() { return PUBLIC_BASE_URL ? PUBLIC_BASE_URL + '/data' : sheets.sheetUrl(); }

const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: config.channelAccessToken });

const pendingBill = {};   // pendingBill[uid] = { bill, stage }
const summaryFlow = {};   // summaryFlow[uid] = { step, from, to }
const editTokens = {};    // editTokens[token] = { uid, exp }

// ล้างบิลที่รอตรวจ + ปิดลิงก์แก้ไขเก่าทั้งหมดของ user (กันบันทึกซ้ำ)
function clearUser(uid) {
  delete pendingBill[uid];
  for (const k of Object.keys(editTokens)) if (editTokens[k].uid === uid) delete editTokens[k];
}

// บันทึกบิล: อัปโหลดรูป (ถ้ามี+ตั้งค่า Cloudinary) -> เขียนชีท -> ล้าง state
async function saveBill(uid, bill, imageBuffer) {
  if (imageBuffer) {
    try {
      const folder = (bill.date && /^\d{4}-\d{2}/.test(bill.date)) ? bill.date.slice(0, 7) : 'misc';
      const url = await upload.uploadImage(imageBuffer, folder);
      if (url) bill.image_url = url;
    } catch (e) { console.error('upload image:', e.message); }
  }
  const id = await sheets.appendBill(uid, bill);
  clearUser(uid);
  return id;
}

const app = express();
app.get('/', (_req, res) => res.send('LINE bill bot is running'));

// ---------- หน้าฟอร์มแก้ไข (LIFF) ----------
let LIFF_HTML = '';
try { LIFF_HTML = fs.readFileSync(path.join(__dirname, 'liff.html'), 'utf8'); } catch (_) {}
app.get('/liff', (_req, res) => {
  if (!LIFF_ID) return res.type('html').send('<h3>ยังไม่ได้ตั้งค่า LIFF_ID</h3>');
  res.type('html').send(LIFF_HTML.replace(/__LIFF_ID__/g, LIFF_ID));
});

// ---------- หน้าดูข้อมูล (อ่านอย่างเดียว + รหัสผ่าน) ----------
let DATA_HTML = '';
try { DATA_HTML = fs.readFileSync(path.join(__dirname, 'data.html'), 'utf8'); } catch (_) {}
app.get('/data', (_req, res) => res.type('html').send(DATA_HTML || '<h3>data.html missing</h3>'));
app.get('/api/data', express.json(), async (req, res) => {
  if (!VIEW_PASSCODE) return res.status(403).json({ ok: false, error: 'ยังไม่ได้ตั้งรหัส (VIEW_PASSCODE)' });
  if ((req.query.pass || '') !== VIEW_PASSCODE) return res.status(403).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
  try { const bills = await sheets.getBills(null); res.json({ ok: true, bills }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- สำรองข้อมูล (คัดลอกแท็บปัจจุบัน) — ต้องใส่รหัสผ่าน ----------
app.get('/api/backup', express.json(), async (req, res) => {
  if (!VIEW_PASSCODE) return res.status(403).json({ ok: false, error: 'ยังไม่ได้ตั้งรหัส (VIEW_PASSCODE)' });
  if ((req.query.pass || '') !== VIEW_PASSCODE) return res.status(403).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
  try { const title = await sheets.backup(); res.json({ ok: true, title }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- API สำหรับฟอร์ม ----------
function tokenUid(t) {
  const e = editTokens[t];
  if (!e || e.exp < Date.now()) return null;
  return e.uid;
}
app.get('/api/bill', express.json(), (req, res) => {
  const uid = tokenUid(req.query.t);
  if (!uid) return res.status(403).json({ ok: false, error: 'token หมดอายุ' });
  const st = pendingBill[uid];
  res.json({ ok: true, bill: (st && st.bill) || {} });
});
app.post('/api/bill', express.json(), async (req, res) => {
  try {
    const { t, fields } = req.body || {};
    const uid = tokenUid(t);
    if (!uid) return res.status(403).json({ ok: false, error: 'token หมดอายุ' });
    const bill = normalizeBill(fields || {});
    const prev = pendingBill[uid] || {};
    const dup = bill.bill_no ? await sheets.billNoExists(bill.bill_no) : false;
    pendingBill[uid] = { bill, stage: 'confirm', imageBuffer: prev.imageBuffer };
    await pushMessage(uid, [billCard(uid, bill, dup)]).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error('api/bill POST', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- webhook ----------
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).end();
  for (const event of req.body.events || []) {
    try { await handleEvent(event); }
    catch (err) {
      console.error('handleEvent error:', err);
      const uid = event.source && event.source.userId;
      if (uid) await pushMessage(uid, [{ type: 'text', text: '⚠️ เกิดข้อผิดพลาด: ' + (err.message || 'ไม่ทราบสาเหตุ') }]).catch(() => {});
    }
  }
});

async function handleEvent(event) {
  const uid = event.source && event.source.userId;
  if (event.type === 'postback') return handlePostback(event, uid);
  if (event.type !== 'message') return;
  const msg = event.message;
  if (msg.type === 'image') return handleImage(event, uid, msg);
  if (msg.type === 'text') return handleText(event, uid, msg.text.trim());
}

// ---------- postback (ปุ่มเลือกวันที่ในสรุป) ----------
async function handlePostback(event, uid) {
  const data = event.postback && event.postback.data;
  const date = event.postback && event.postback.params && event.postback.params.date;
  const flow = summaryFlow[uid];
  if (!flow || !date) return;
  if (data === 'sum_from') {
    flow.from = date; flow.step = 'picking';
    return safeReply(event.replyToken, [datePickerMsg('เลือก “วันสิ้นสุด”', 'sum_to', '📅 เลือกวันสิ้นสุด')]);
  }
  if (data === 'sum_to') {
    let from = flow.from, to = date;
    if (from && to && from > to) { const tmp = from; from = to; to = tmp; }
    flow.from = from; flow.to = to; flow.step = 'group';
    return safeReply(event.replyToken, [groupQuestion(from, to)]);
  }
}

// ---------- รูปบิล ----------
async function handleImage(event, uid, msg) {
  await safeReply(event.replyToken, [{ type: 'text', text: '📸 กำลังอ่านบิล รอสักครู่...' }]);
  const buffer = await downloadContent(msg.id);
  const bill = await readBill(buffer, 'image/jpeg');
  bill.date = ceDate(bill.date);
  delete summaryFlow[uid];
  pendingBill[uid] = { bill, stage: 'confirm', imageBuffer: buffer };
  const dup = bill.bill_no ? await sheets.billNoExists(bill.bill_no) : false;
  await pushMessage(uid, [billCard(uid, bill, dup)]);
}

// ---------- ข้อความ ----------
async function handleText(event, uid, text) {
  const st = pendingBill[uid];
  if (st) {
    if (/^(ยืนยัน|ตกลง|ok|yes|✅)/i.test(text)) {
      if (st.bill.bill_no && await sheets.billNoExists(st.bill.bill_no)) {
        return safeReply(event.replyToken, [{ type: 'text', text: '⚠️ บิลเลขที่ ' + st.bill.bill_no + ' เคยบันทึกไปแล้ว ไม่บันทึกซ้ำ\nถ้าเป็นคนละใบ กดแก้ไขแล้วเปลี่ยนเลขที่บิล' }]);
      }
      const id = await saveBill(uid, st.bill, st.imageBuffer);
      return safeReply(event.replyToken, [{ type: 'text', text: savedText(id, st.bill) }]);
    }
    if (/^(แก้ไข|แก้|edit|✏️)/i.test(text) && st.stage === 'confirm') {
      st.stage = 'edit';
      return safeReply(event.replyToken, [{ type: 'text', text:
        '✏️ พิมพ์เฉพาะช่องที่จะแก้ (คั่นด้วยขึ้นบรรทัด/คอมม่า) เช่น:\nสาขา=ยะลา\nเจ้าของงาน=คุณซ้อง\nบริษัทผ้า=Nava\nค่าขนส่ง=670' }]);
    }
    if (/^(ยกเลิก|cancel)/i.test(text)) {
      delete pendingBill[uid];
      return safeReply(event.replyToken, [{ type: 'text', text: '❌ ยกเลิกบิลนี้แล้ว' }]);
    }
    if (st.stage === 'edit') {
      const edits = parseEdit(text);
      if (!Object.keys(edits).length) return safeReply(event.replyToken, [{ type: 'text', text: 'ไม่เข้าใจรูปแบบ ลองใหม่ เช่น  สาขา=ยะลา' }]);
      Object.assign(st.bill, edits);
      st.stage = 'confirm';
      const dup2 = st.bill.bill_no ? await sheets.billNoExists(st.bill.bill_no) : false;
      return safeReply(event.replyToken, [billCard(uid, st.bill, dup2)]);
    }
  }

  if (summaryFlow[uid]) return handleSummaryFlow(event, uid, text);

  if (/^(สำรองข้อมูล|สำรอง|backup)\s*$/i.test(text)) {
    await safeReply(event.replyToken, [{ type: 'text', text: '💾 กำลังสำรองข้อมูล...' }]);
    try { const title = await sheets.backup(); return pushMessage(uid, [{ type: 'text', text: '✅ สำรองข้อมูลแล้ว\nสร้างแท็บ "' + title + '" ในชีท (ข้อมูลต้นฉบับยังอยู่ครบ)' }]); }
    catch (e) { return pushMessage(uid, [{ type: 'text', text: '⚠️ สำรองไม่สำเร็จ: ' + e.message }]); }
  }

  if (/^(รวมยอด|สรุป|summary)\s*$/i.test(text)) {
    summaryFlow[uid] = { step: 'range' };
    return safeReply(event.replyToken, [rangeQuestion()]);
  }
  const cmd = parseCommand(text);
  if (cmd && cmd.type === 'help') return safeReply(event.replyToken, [{ type: 'text', text: helpText() }]);
  if (cmd && cmd.type === 'sheet') return safeReply(event.replyToken, [{ type: 'text', text: '🗂️ ดูข้อมูลบิล (อ่านอย่างเดียว):\n' + dataUrl() }]);
  if (cmd && cmd.type === 'recent') return safeReply(event.replyToken, [{ type: 'text', text: await recentText(uid) }]);
  if (cmd && cmd.type === 'summary') {
    const s = await sheets.summarize(uid, cmd.from, cmd.to, cmd.groupBy);
    return safeReply(event.replyToken, [{ type: 'text', text: summaryText(s, cmd.from, cmd.to, cmd.groupBy) }]);
  }
  if (/ถ่ายรูป|ถ่ายบิล/.test(text)) return safeReply(event.replyToken, [{ type: 'text', text: '📸 ส่งรูปบิลเข้ามาได้เลย' }]);
  return safeReply(event.replyToken, [{ type: 'text', text: helpText() }]);
}

// ---------- flow สรุป ----------
async function handleSummaryFlow(event, uid, text) {
  const flow = summaryFlow[uid];
  if (/^(ยกเลิก|cancel)/i.test(text)) { delete summaryFlow[uid]; return safeReply(event.replyToken, [{ type: 'text', text: '❌ ยกเลิกการสรุป' }]); }
  if (flow.step === 'range') {
    if (/ระบุ|เอง|กำหนด/.test(text)) { flow.step = 'picking'; return safeReply(event.replyToken, [datePickerMsg('เลือก “วันเริ่มต้น”', 'sum_from', '📅 เลือกวันเริ่ม')]); }
    const r = parseCommand('สรุป ' + text);
    flow.from = r.from; flow.to = r.to; flow.step = 'group';
    return safeReply(event.replyToken, [groupQuestion(flow.from, flow.to)]);
  }
  if (flow.step === 'range_text') {
    const r = parseCommand('สรุป ' + text);
    flow.from = r.from; flow.to = r.to; flow.step = 'group';
    return safeReply(event.replyToken, [groupQuestion(flow.from, flow.to)]);
  }
  if (flow.step === 'group') {
    let groupBy = null;
    if (/ผ้า/.test(text)) groupBy = 'fabric_company';
    else if (/สาขา/.test(text)) groupBy = 'branch';
    else if (/ขนส่ง/.test(text)) groupBy = 'courier';
    const { from, to } = flow;
    delete summaryFlow[uid];
    const s = await sheets.summarize(uid, from, to, groupBy);
    return safeReply(event.replyToken, [{ type: 'text', text: summaryText(s, from, to, groupBy) }]);
  }
}

// ---------- การ์ดบิล ----------
function makeEditUrl(uid) {
  if (!LIFF_ID) return null;
  const t = crypto.randomUUID().replace(/-/g, '');
  editTokens[t] = { uid, exp: Date.now() + 30 * 60 * 1000 };
  return `https://liff.line.me/${LIFF_ID}?t=${t}`;
}

function billCard(uid, b, dup) {
  const L = [];
  L.push('🧾 ตรวจสอบบิลขนส่ง');
  if (dup) L.push('⚠️ เลขที่บิลนี้เคยบันทึกแล้ว!');
  L.push('━ ข้อมูล ━');
  L.push('📅 วันที่: ' + (b.date || '-'));
  L.push('🏪 สาขา: ' + (b.branch || '-'));
  L.push('👤 เจ้าของงาน: ' + (b.job_owner || '-'));
  L.push('🚚 ขนส่ง: ' + (b.courier || '-') + (b.bill_no ? ('  #' + b.bill_no) : ''));
  L.push('💳 เก็บเงิน: ' + (b.payment || '-'));
  L.push('━ สินค้า ━');
  L.push('🧵 บริษัทผ้า: ' + (b.fabric_company || '-'));
  L.push('📦 ประเภท: ' + (b.item_type || '-'));
  if (b.item) L.push('📋 รายการ: ' + b.item);
  if (b.fabric_code) L.push('🏷️ รหัสผ้า: ' + b.fabric_code);
  L.push('🔢 จำนวน: ' + (b.qty != null ? b.qty : '-') + (b.unit ? ' ' + b.unit : ''));
  L.push('━ ราคา ━');
  L.push('💰 ค่าขนส่ง: ' + fmt(b.shipping_cost) + ' บาท');
  const missing = [];
  if (!b.branch) missing.push('สาขา');
  if (!b.job_owner) missing.push('เจ้าของงาน');
  L.push('');
  L.push(missing.length ? ('⚠️ ยังไม่มี: ' + missing.join(', ') + ' — กดแก้ไขเพื่อเติม') : 'ตรวจสอบแล้ว กดยืนยัน หรือแก้ไข');

  const editUrl = makeEditUrl(uid);
  const editAction = editUrl
    ? { type: 'action', action: { type: 'uri', label: '✏️ แก้ไข', uri: editUrl } }
    : qrMsg('✏️ แก้ไข', 'แก้ไข');
  return {
    type: 'text', text: L.join('\n'),
    quickReply: { items: [ qrMsg('✅ ยืนยัน', 'ยืนยัน'), editAction, qrMsg('❌ ยกเลิก', 'ยกเลิก') ] },
  };
}

function datePickerMsg(text, data, label) {
  return { type: 'text', text, quickReply: { items: [
    { type: 'action', action: { type: 'datetimepicker', label, data, mode: 'date' } },
    qrMsg('❌ ยกเลิก', 'ยกเลิก'),
  ] } };
}

function rangeQuestion() {
  return { type: 'text', text: '📊 รวมยอดค่าขนส่ง — เลือกช่วงเวลา', quickReply: { items: [
    qrMsg('รอบบิล (15→14)', 'รอบบิล'), qrMsg('เดือนนี้', 'เดือนนี้'),
    qrMsg('เดือนที่แล้ว', 'เดือนที่แล้ว'), qrMsg('ระบุช่วงเอง', 'ระบุช่วงเอง'),
  ] } };
}
function groupQuestion(from, to) {
  return { type: 'text', text: `ช่วง ${from} ถึง ${to}\nต้องการสรุปแบบไหน?`, quickReply: { items: [
    qrMsg('รวมทั้งหมด', 'รวมทั้งหมด'), qrMsg('แยกตามบริษัทผ้า', 'แยกตามบริษัทผ้า'), qrMsg('แยกตามขนส่ง', 'แยกตามขนส่ง'),
  ] } };
}
function fmtDay(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? (m[3] + '/' + m[2]) : (d || '-');
}
function summaryText(s, from, to, groupBy) {
  const DIV = '━━━━━━━━━━━━━';
  if (s.count === 0) return `📊 สรุปค่าขนส่ง\n🗓 ${from} ถึง ${to}\n${DIV}\nไม่พบบิลในช่วงนี้`;
  const gkey = (b) => (b[groupBy] || '(ไม่ระบุ)').toString().trim() || '(ไม่ระบุ)';
  const byDate = [...s.bills].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const L = ['📊 สรุปค่าขนส่ง', `🗓 ${from} ถึง ${to}`, DIV, `รวม ${s.count} บิล · ${fmt(s.total)} บาท`];
  if (groupBy) {
    const label = groupBy === 'fabric_company' ? '🧵 แยกตามบริษัทผ้า'
      : groupBy === 'branch' ? '🏪 แยกตามสาขา' : '🚚 แยกตามขนส่ง';
    L.push('', label);
    for (const [name, g] of Object.entries(s.groups).sort((a, b) => b[1].cost - a[1].cost)) {
      L.push('', `▸ ${name}`, `   ${fmt(g.cost)} บาท · ${g.count} บิล`);
      let i = 1;
      for (const b of byDate.filter((x) => gkey(x) === name)) {
        L.push(`   ${i++}) ${fmtDay(b.date)}  ${b.job_owner || '-'}  —  ${fmt(b.shipping_cost)}`);
      }
    }
  } else {
    L.push('', 'รายการ (เรียงวันที่)', DIV);
    let i = 1;
    for (const b of byDate) {
      L.push(`${i++}) ${fmtDay(b.date)}  ${b.branch || '-'} · ${b.job_owner || '-'}  —  ${fmt(b.shipping_cost)}`);
    }
  }
  let out = L.join('\n');
  if (out.length > 4800) out = out.slice(0, 4700) + '\n…(ตัดบางส่วน ดูทั้งหมดในชีท)';
  return out;
}

async function recentText(uid) {
  const bills = await sheets.recentBills(uid, 5);
  if (!bills.length) return '🗂️ ยังไม่มีบิลที่บันทึก';
  const L = ['🗂️ บิลล่าสุด:'];
  bills.forEach((b, i) => L.push(`${i + 1}) ${b.date || '-'} · ${b.branch || '-'} · ${b.courier || '-'} · ${fmt(b.shipping_cost)} บาท`));
  L.push('\nดูทั้งหมด: ' + dataUrl());
  return L.join('\n');
}
function helpText() {
  return '👋 วิธีใช้งาน\n\n📸 ส่งรูปบิล → ตรวจ → กดยืนยัน บันทึกลงชีท\n📊 "รวมยอด" → เลือกช่วง แล้วแยกตามบริษัทผ้า/ขนส่ง\n🗂️ "เปิดชีท" → ลิงก์ดูข้อมูลบิล\n🧾 "บิลล่าสุด" → 5 รายการหลังสุด\n💾 "สำรองข้อมูล" → คัดลอกข้อมูลกันหาย';
}
function savedText(id, b) {
  const L = ['✅ บันทึกแล้ว (รหัส ' + id + ')', ''];
  L.push('📅 ' + (b.date || '-') + '   🏪 ' + (b.branch || '-'));
  L.push('👤 ' + (b.job_owner || '-'));
  L.push('🧵 ' + (b.fabric_company || '-') + (b.item_type ? ('  ·  ' + b.item_type) : ''));
  if (b.item) L.push('📋 ' + b.item);
  if (b.fabric_code) L.push('🏷️ รหัสผ้า ' + b.fabric_code);
  L.push('🔢 ' + (b.qty != null ? b.qty : '-') + (b.unit ? ' ' + b.unit : ''));
  L.push('🚚 ' + (b.courier || '-') + (b.bill_no ? ('  #' + b.bill_no) : ''));
  L.push('💰 ค่าขนส่ง ' + fmt(b.shipping_cost) + ' บาท' + (b.payment ? ('  (' + b.payment + ')') : ''));
  if (b.image_url) L.push('🖼️ ' + b.image_url);
  L.push('', 'พิมพ์ "รวมยอด" ดูสรุป หรือส่งบิลใบใหม่');
  return L.join('\n');
}

// ---------- utils ----------
function fmt(n) { if (n == null || n === '') return '0'; return Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 }); }
function qrMsg(label, text) { return { type: 'action', action: { type: 'message', label, text } }; }
function num(v) { const n = parseFloat(String(v).replace(/[, ฿]/g, '')); return Number.isNaN(n) ? null : n; }
function ceDate(s) { s = String(s || '').trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return s || null; let y = parseInt(m[1], 10); if (y >= 2400) y -= 543; return y + '-' + m[2] + '-' + m[3]; }
function normalizeBill(f) {
  return {
    date: ceDate(f.date), branch: f.branch || null, job_owner: f.job_owner || null,
    fabric_company: f.fabric_company || null,
    item_type: f.item_type || null, item: f.item || null, fabric_code: f.fabric_code || null,
    qty: num(f.qty), unit: f.unit || null,
    courier: f.courier || null, bill_no: f.bill_no || null,
    shipping_cost: num(f.shipping_cost), payment: f.payment || null, image_url: f.image_url || null,
  };
}
async function downloadContent(messageId) {
  const stream = await blobClient.getMessageContent(messageId);
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
async function safeReply(replyToken, messages) { if (!replyToken) return; return client.replyMessage({ replyToken, messages }); }
async function pushMessage(to, messages) { return client.pushMessage({ to, messages }); }

// ---------- Rich Menu ----------
async function ensureRichMenu() {
  if (!config.channelAccessToken) return;
  try {
    if (process.env.REBUILD_RICHMENU === '1') {
      const list = await client.getRichMenuList().catch(() => ({ richmenus: [] }));
      for (const rm of list.richmenus || []) await client.deleteRichMenu(rm.richMenuId).catch(() => {});
    } else {
      const def = await client.getDefaultRichMenuId().catch(() => null);
      if (def && def.richMenuId) { console.log('rich menu already set'); return; }
    }
    const richMenu = {
      size: { width: 2500, height: 843 }, selected: true, name: 'bill-menu', chatBarText: 'เมนู',
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'message', text: 'รวมยอด' } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'uri', uri: dataUrl() } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: 'camera', label: 'ถ่ายรูป' } },
      ],
    };
    const created = await client.createRichMenu(richMenu);
    const img = fs.readFileSync(path.join(__dirname, 'richmenu.png'));
    await blobClient.setRichMenuImage(created.richMenuId, new Blob([img], { type: 'image/png' }));
    await client.setDefaultRichMenu(created.richMenuId);
    console.log('✅ rich menu set:', created.richMenuId);
  } catch (e) { console.error('ensureRichMenu error:', e.message); }
}

const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`✅ LINE bill bot listening on :${port}`); ensureRichMenu(); });
