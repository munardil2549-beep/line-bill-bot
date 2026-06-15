// index.js — LINE bot อ่านบิลขนส่ง ยืนยัน/แก้ไข บันทึกชีท และสรุปยอด (แยกสาขา/ขนส่ง)
try { require('dotenv').config(); } catch (_) { /* production ใช้ env จริง */ }

const fs = require('fs');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');

const { readBill } = require('./lib/reader');
const sheets = require('./lib/sheets');
const { parseCommand, parseEdit } = require('./lib/parser');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: config.channelAccessToken });

// สถานะต่อผู้ใช้ (ในหน่วยความจำ — รีเซ็ตเมื่อรีสตาร์ท)
const pendingBill = {};   // pendingBill[uid] = { bill, stage:'confirm'|'edit' }
const summaryFlow = {};   // summaryFlow[uid] = { step:'range'|'range_text'|'group', from, to }

const app = express();
app.get('/', (_req, res) => res.send('LINE bill bot is running'));

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).end();
  for (const event of req.body.events || []) {
    try {
      await handleEvent(event);
    } catch (err) {
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
  await pushMessage(uid, [billCard(bill)]);
}

// ---------- ข้อความ ----------
async function handleText(event, uid, text) {
  // 1) อยู่ระหว่างยืนยัน/แก้ไขบิล
  const st = pendingBill[uid];
  if (st) {
    if (/^(ยืนยัน|ตกลง|ok|yes|✅)/i.test(text)) {
      const id = await sheets.appendBill(uid, st.bill);
      delete pendingBill[uid];
      return safeReply(event.replyToken, [{ type: 'text', text:
        `✅ บันทึกแล้ว (รหัส ${id})\nสาขา ${st.bill.branch || '-'} · ค่าขนส่ง ${fmt(st.bill.shipping_cost)} บาท\n\nกด "รวมยอด" ดูสรุป หรือส่งบิลใบใหม่ได้เลย` }]);
    }
    if (/^(แก้ไข|แก้|edit|✏️)/i.test(text) && st.stage === 'confirm') {
      st.stage = 'edit';
      return safeReply(event.replyToken, [{ type: 'text', text:
        '✏️ พิมพ์สิ่งที่ต้องการแก้ (คั่นหลายอันด้วยขึ้นบรรทัด/คอมม่า) เช่น:\n' +
        'สาขา=ยะลา\nเจ้าของงาน=ซิลมี\nชื่องาน=ผ้าม่านห้องนอน\nค่าขนส่ง=150\nวันที่=2026-06-04\nขนส่ง=ไชยรักษ์เอ็กซ์เพรส\nจำนวน=1\nวิธีเก็บเงิน=ปลายทาง' }]);
    }
    if (/^(ยกเลิก|cancel)/i.test(text)) {
      delete pendingBill[uid];
      return safeReply(event.replyToken, [{ type: 'text', text: '❌ ยกเลิกบิลนี้แล้ว' }]);
    }
    if (st.stage === 'edit') {
      const edits = parseEdit(text);
      if (!Object.keys(edits).length) {
        return safeReply(event.replyToken, [{ type: 'text', text: 'ไม่เข้าใจรูปแบบ ลองใหม่ เช่น  สาขา=ยะลา  หรือ  ค่าขนส่ง=150' }]);
      }
      Object.assign(st.bill, edits);
      st.stage = 'confirm';
      return safeReply(event.replyToken, [billCard(st.bill)]);
    }
  }

  // 2) อยู่ใน flow สรุปยอด
  if (summaryFlow[uid]) return handleSummaryFlow(event, uid, text);

  // 3) คำสั่งทั่วไป
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

// ---------- flow สรุปยอด ----------
async function handleSummaryFlow(event, uid, text) {
  const flow = summaryFlow[uid];
  if (/^(ยกเลิก|cancel)/i.test(text)) { delete summaryFlow[uid]; return safeReply(event.replyToken, [{ type: 'text', text: '❌ ยกเลิกการสรุป' }]); }

  if (flow.step === 'range') {
    if (/ระบุ|เอง|กำหนด/.test(text)) {
      flow.step = 'range_text';
      return safeReply(event.replyToken, [{ type: 'text', text: 'พิมพ์ช่วงวันที่ เช่น  1/6/2026 ถึง 15/6/2026' }]);
    }
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

// ---------- ข้อความ/การ์ด ----------
function billCard(b) {
  const L = [];
  L.push('🧾 ตรวจสอบบิลขนส่ง');
  L.push('🚚 ขนส่ง: ' + (b.courier || '-'));
  L.push('📅 วันที่: ' + (b.date || '-'));
  L.push('🏪 สาขา: ' + (b.branch || '-'));
  L.push('👤 เจ้าของงาน: ' + (b.job_owner || '-'));
  L.push('📋 ชื่องาน: ' + (b.job_name || '-'));
  L.push('📦 รายการ: ' + (b.item || '-'));
  L.push('🔢 จำนวน: ' + (b.qty != null ? b.qty + ' ชิ้น' : '-'));
  L.push('💰 ค่าขนส่ง: ' + fmt(b.shipping_cost) + ' บาท');

  const missing = [];
  if (!b.branch) missing.push('สาขา');
  if (!b.job_owner) missing.push('เจ้าของงาน');
  if (!b.job_name) missing.push('ชื่องาน');
  L.push('');
  if (missing.length) {
    L.push('⚠️ ยังไม่มี: ' + missing.join(', ') + ' — พิมพ์เพิ่มได้ เช่น สาขา=ยะลา');
  } else {
    L.push('ถูกต้องไหม? กดยืนยัน หรือพิมพ์ "แก้ไข"');
  }
  return {
    type: 'text',
    text: L.join('\n'),
    quickReply: { items: [
      qrMsg('✅ ยืนยัน', 'ยืนยัน'),
      qrMsg('✏️ แก้ไข', 'แก้ไข'),
      qrMsg('❌ ยกเลิก', 'ยกเลิก'),
    ] },
  };
}

function rangeQuestion() {
  return {
    type: 'text',
    text: '📊 รวมยอดค่าขนส่ง — เลือกช่วงเวลา',
    quickReply: { items: [
      qrMsg('เดือนนี้', 'เดือนนี้'),
      qrMsg('เดือนที่แล้ว', 'เดือนที่แล้ว'),
      qrMsg('7 วัน', '7 วัน'),
      qrMsg('ระบุช่วงเอง', 'ระบุช่วงเอง'),
    ] },
  };
}

function groupQuestion(from, to) {
  return {
    type: 'text',
    text: `ช่วง ${from} ถึง ${to}\nต้องการสรุปแบบไหน?`,
    quickReply: { items: [
      qrMsg('รวมทั้งหมด', 'รวมทั้งหมด'),
      qrMsg('แยกตามสาขา', 'แยกตามสาขา'),
      qrMsg('แยกตามขนส่ง', 'แยกตามขนส่ง'),
    ] },
  };
}

function summaryText(s, from, to, groupBy) {
  if (s.count === 0) return `📊 ช่วง ${from} ถึง ${to}\nไม่พบบิลในช่วงนี้`;
  const L = [];
  L.push(`📊 สรุปค่าขนส่ง ${from} ถึง ${to}`);
  L.push(`จำนวนบิล: ${s.count} ใบ · ${s.qty} ชิ้น`);
  L.push(`💰 รวมทั้งหมด: ${fmt(s.total)} บาท`);
  if (groupBy) {
    L.push('');
    L.push(groupBy === 'branch' ? '🏪 แยกตามสาขา:' : '🚚 แยกตามบริษัทขนส่ง:');
    const arr = Object.entries(s.groups).sort((a, b) => b[1].cost - a[1].cost);
    for (const [name, g] of arr) {
      L.push(`  • ${name}: ${fmt(g.cost)} บาท (${g.count} บิล)`);
    }
  }
  return L.join('\n');
}

async function recentText(uid) {
  const bills = await sheets.recentBills(uid, 5);
  if (!bills.length) return '🗂️ ยังไม่มีบิลที่บันทึก';
  const L = ['🗂️ บิลล่าสุด:'];
  bills.forEach((b, i) => {
    L.push(`${i + 1}) ${b.date || '-'} · ${b.branch || '-'} · ${b.courier || '-'} · ${fmt(b.shipping_cost)} บาท`);
  });
  L.push('\nเปิดทั้งหมด: ' + sheets.sheetUrl());
  return L.join('\n');
}

function helpText() {
  return (
    '👋 วิธีใช้งาน\n\n' +
    '📸 ส่งรูปบิล → บอทอ่านให้ตรวจ → กดยืนยัน บันทึกลงชีท\n' +
    '📊 พิมพ์ "รวมยอด" → เลือกช่วงเวลา แล้วเลือกแยกตามสาขา/ขนส่ง\n' +
    '🗂️ พิมพ์ "เปิดชีท" → ลิงก์เปิดดาต้าเบส\n' +
    '🧾 พิมพ์ "บิลล่าสุด" → ดู 5 รายการหลังสุด\n\n' +
    'แก้ข้อมูลบิลพิมพ์ เช่น  สาขา=ยะลา  ค่าขนส่ง=150'
  );
}

// ---------- utils ----------
function fmt(n) {
  if (n == null || n === '') return '0';
  return Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}
function qrMsg(label, text) {
  return { type: 'action', action: { type: 'message', label, text } };
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
async function safeReply(replyToken, messages) {
  if (!replyToken) return;
  return client.replyMessage({ replyToken, messages });
}
async function pushMessage(to, messages) {
  return client.pushMessage({ to, messages });
}

// ---------- Rich Menu (เมนู 3 ปุ่มล่างจอ) ----------
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
      size: { width: 2500, height: 843 },
      selected: true,
      name: 'bill-menu',
      chatBarText: 'เมนู',
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'message', text: 'รวมยอด' } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'uri', uri: sheets.sheetUrl() } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: 'camera', label: 'ถ่ายรูป' } },
      ],
    };
    const created = await client.createRichMenu(richMenu);
    const id = created.richMenuId;
    const img = fs.readFileSync(path.join(__dirname, 'richmenu.png'));
    await blobClient.setRichMenuImage(id, new Blob([img], { type: 'image/png' }));
    await client.setDefaultRichMenu(id);
    console.log('✅ rich menu set:', id);
  } catch (e) {
    console.error('ensureRichMenu error:', e.message);
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ LINE bill bot listening on :${port}`);
  ensureRichMenu();
});
