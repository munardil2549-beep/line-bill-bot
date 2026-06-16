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

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const LIFF_ID = process.env.LIFF_ID || '';

const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: config.channelAccessToken });

const pendingBill = {};   // pendingBill[uid] = { bill, stage }
const summaryFlow = {};   // summaryFlow[uid] = { step, from, to }
const editTokens = {};    // editTokens[token] = { uid, exp }

const app = express();
app.get('/', (_req, res) => res.send('LINE bill bot is running'));

// ---------- หน้าฟอร์มแก้ไข (LIFF) ----------
let LIFF_HTML = '';
try { LIFF_HTML = fs.readFileSync(path.join(__dirname, 'liff.html'), 'utf8'); } catch (_) {}
app.get('/liff', (_req, res) => {
  if (!LIFF_ID) return res.type('html').send('<h3>ยังไม่ได้ตั้งค่า LIFF_ID</h3>');
  res.type('html').send(LIFF_HTML.replace(/__LIFF_ID__/g, LIFF_ID));
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
    const id = await sheets.appendBill(uid, bill);
    delete pendingBill[uid];
    delete editTokens[t];
    await pushMessage(uid, [{ type: 'text', text: savedText(id, bill) }]).catch(() => {});
    res.json({ ok: true, billId: id });
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
  if (event.type !== 'message') return;
  const uid = event.source && event.source.userId;
  const msg = event.message;
  if (msg.type === 'image') return handleImage(event, uid, msg);
  if (msg.type === 'text') return handleText(event, uid, msg.text.trim());
}

// ---------- รูปบิล ----------
async function handleImage(event, uid, msg) {
  await safeReply(event.replyToken, [{ type: 'text', text: '📸 กำลังอ่านบิล รอสักครู่...' }]);
  const buffer = await downloadContent(msg.id);
  const bill = await readBill(buffer, 'image/jpeg');
  delete summaryFlow[uid];
  pendingBill[uid] = { bill, stage: 'confirm' };
  await pushMessage(uid, [billCard(uid, bill)]);
}

// ---------- ข้อความ ----------
async function handleText(event, uid, text) {
  const st = pendingBill[uid];
  if (st) {
    if (/^(ยืนยัน|ตกลง|ok|yes|✅)/i.test(text)) {
      const id = await sheets.appendBill(uid, st.bill);
      delete pendingBill[uid];
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
      return safeReply(event.replyToken, [billCard(uid, st.bill)]);
    }
  }

  if (summaryFlow[uid]) return handleSummaryFlow(event, uid, text);

  if (/^(รวมยอด|สรุป|summary)\s*$/i.test(text)) {
    summaryFlow[uid] = { step: 'range' };
    return safeReply(event.replyToken, [rangeQuestion()]);
  }
  const cmd = parseCommand(text);
  if (cmd && cmd.type === 'help') return safeReply(event.replyToken, [{ type: 'text', text: helpText() }]);
  if (cmd && cmd.type === 'sheet') return safeReply(event.replyToken, [{ type: 'text', text: '🗂️ เปิดดาต้าเบส (Google Sheet):\n' + sheets.sheetUrl() }]);
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
    if (/ระบุ|เอง|กำหนด/.test(text)) { flow.step = 'range_text'; return safeReply(event.replyToken, [{ type: 'text', text: 'พิมพ์ช่วงวันที่ เช่น  1/6/2026 ถึง 15/6/2026' }]); }
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
    if (/สาขา/.test(text)) groupBy = 'branch';
    else if (/ขนส่ง|บริษัท/.test(text)) groupBy = 'courier';
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

function billCard(uid, b) {
  const L = [];
  L.push('🧾 ตรวจสอบบิลขนส่ง');
  L.push('🚚 ขนส่ง: ' + (b.courier || '-'));
  L.push('📅 วันที่: ' + (b.date || '-'));
  L.push('🏪 สาขา: ' + (b.branch || '-'));
  L.push('👤 เจ้าของงาน: ' + (b.job_owner || '-'));
  L.push('🧵 บริษัทผ้า: ' + (b.fabric_company || '-'));
  L.push('📦 รายการ: ' + (b.item || '-'));
  L.push('🔢 จำนวน: ' + (b.qty != null ? b.qty + ' ชิ้น' : '-'));
  L.push('💰 ค่าขนส่ง: ' + fmt(b.shipping_cost) + ' บาท');
  const missing = [];
  if (!b.branch) missing.push('สาขา');
  if (!b.job_owner) missing.push('เจ้าของงาน');
  L.push('');
  L.push(missing.length ? ('⚠️ ยังไม่มี: ' + missing.join(', ') + ' — กดแก้ไขเพื่อเติม') : 'ถูกต้องไหม? กดยืนยัน หรือแก้ไข');

  const editUrl = makeEditUrl(uid);
  const editAction = editUrl
    ? { type: 'action', action: { type: 'uri', label: '✏️ แก้ไข', uri: editUrl } }
    : qrMsg('✏️ แก้ไข', 'แก้ไข');
  return {
    type: 'text', text: L.join('\n'),
    quickReply: { items: [ qrMsg('✅ ยืนยัน', 'ยืนยัน'), editAction, qrMsg('❌ ยกเลิก', 'ยกเลิก') ] },
  };
}

function rangeQuestion() {
  return { type: 'text', text: '📊 รวมยอดค่าขนส่ง — เลือกช่วงเวลา', quickReply: { items: [
    qrMsg('รอบบิล (15→14)', 'รอบบิล'), qrMsg('เดือนนี้', 'เดือนนี้'),
    qrMsg('เดือนที่แล้ว', 'เดือนที่แล้ว'), qrMsg('ระบุช่วงเอง', 'ระบุช่วงเอง'),
  ] } };
}
function groupQuestion(from, to) {
  return { type: 'text', text: `ช่วง ${from} ถึง ${to}\nต้องการสรุปแบบไหน?`, quickReply: { items: [
    qrMsg('รวมทั้งหมด', 'รวมทั้งหมด'), qrMsg('แยกตามสาขา', 'แยกตามสาขา'), qrMsg('แยกตามขนส่ง', 'แยกตามขนส่ง'),
  ] } };
}
function summaryText(s, from, to, groupBy) {
  if (s.count === 0) return `📊 ช่วง ${from} ถึง ${to}\nไม่พบบิลในช่วงนี้`;
  const L = [`📊 สรุปค่าขนส่ง ${from} ถึง ${to}`, `จำนวนบิล: ${s.count} ใบ · ${s.qty} ชิ้น`, `💰 รวมทั้งหมด: ${fmt(s.total)} บาท`];
  if (groupBy) {
    L.push('', groupBy === 'branch' ? '🏪 แยกตามสาขา:' : '🚚 แยกตามบริษัทขนส่ง:');
    for (const [name, g] of Object.entries(s.groups).sort((a, b) => b[1].cost - a[1].cost)) {
      L.push(`  • ${name}: ${fmt(g.cost)} บาท (${g.count} บิล)`);
    }
  }
  return L.join('\n');
}
async function recentText(uid) {
  const bills = await sheets.recentBills(uid, 5);
  if (!bills.length) return '🗂️ ยังไม่มีบิลที่บันทึก';
  const L = ['🗂️ บิลล่าสุด:'];
  bills.forEach((b, i) => L.push(`${i + 1}) ${b.date || '-'} · ${b.branch || '-'} · ${b.courier || '-'} · ${fmt(b.shipping_cost)} บาท`));
  L.push('\nเปิดทั้งหมด: ' + sheets.sheetUrl());
  return L.join('\n');
}
function helpText() {
  return '👋 วิธีใช้งาน\n\n📸 ส่งรูปบิล → ตรวจ → กดยืนยัน บันทึกลงชีท\n📊 "รวมยอด" → เลือกช่วง แล้วแยกตามสาขา/ขนส่ง\n🗂️ "เปิดชีท" → ลิงก์ดาต้าเบส\n🧾 "บิลล่าสุด" → 5 รายการหลังสุด';
}
function savedText(id, b) {
  return `✅ บันทึกแล้ว (รหัส ${id})\nสาขา ${b.branch || '-'} · เจ้าของงาน ${b.job_owner || '-'} · ค่าขนส่ง ${fmt(b.shipping_cost)} บาท\n\nกด "รวมยอด" ดูสรุป หรือส่งบิลใบใหม่ได้เลย`;
}

// ---------- utils ----------
function fmt(n) { if (n == null || n === '') return '0'; return Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 }); }
function qrMsg(label, text) { return { type: 'action', action: { type: 'message', label, text } }; }
function num(v) { const n = parseFloat(String(v).replace(/[, ฿]/g, '')); return Number.isNaN(n) ? null : n; }
function normalizeBill(f) {
  return {
    date: f.date || null, branch: f.branch || null, job_owner: f.job_owner || null,
    fabric_company: f.fabric_company || null, courier: f.courier || null, bill_no: f.bill_no || null,
    item: f.item || null, qty: num(f.qty), shipping_cost: num(f.shipping_cost), payment: f.payment || null,
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
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'uri', uri: sheets.sheetUrl() } },
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
