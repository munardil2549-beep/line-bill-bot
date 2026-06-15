// index.js — LINE bot อ่านบิล ยืนยัน/แก้ไข และสรุปยอด
try { require('dotenv').config(); } catch (_) { /* บน production ใช้ env จริง ไม่ต้องมี dotenv */ }

const express = require('express');
const line = require('@line/bot-sdk');

const { readBill } = require('./lib/gemini');
const sheets = require('./lib/sheets');
const { parseCommand, parseEdit } = require('./lib/parser');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.channelAccessToken,
});

// เก็บบิลที่รอยืนยัน/แก้ไข ต่อ user (ในหน่วยความจำ — รีเซ็ตเมื่อรีสตาร์ท)
// pending[userId] = { bill, stage: 'confirm' | 'edit' }
const pending = {};

const app = express();

// health check
app.get('/', (_req, res) => res.send('LINE bill bot is running ✅'));

// webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).end(); // ตอบ LINE ทันที แล้วค่อยประมวลผล
  const events = req.body.events || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('handleEvent error:', err);
      if (event.replyToken) {
        await safeReply(event.replyToken, [
          { type: 'text', text: '⚠️ เกิดข้อผิดพลาด: ' + (err.message || 'ไม่ทราบสาเหตุ') },
        ]).catch(() => {});
      }
    }
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const userId = event.source && event.source.userId;
  const msg = event.message;

  if (msg.type === 'image') {
    return handleImage(event, userId, msg);
  }
  if (msg.type === 'text') {
    return handleText(event, userId, msg.text.trim());
  }
}

// ---------- รูปบิล ----------
async function handleImage(event, userId, msg) {
  await safeReply(event.replyToken, [{ type: 'text', text: '📸 กำลังอ่านบิล รอสักครู่...' }]);

  const buffer = await downloadContent(msg.id);
  const bill = await readBill(buffer, 'image/jpeg');
  pending[userId] = { bill, stage: 'confirm' };

  await pushMessage(userId, [billSummaryMessage(bill)]);
}

// ---------- ข้อความ ----------
async function handleText(event, userId, text) {
  const state = pending[userId];

  // อยู่ในขั้นตอนยืนยัน/แก้ไขบิล
  if (state) {
    // ยืนยัน
    if (/^(ยืนยัน|ตกลง|ok|yes|✅)/i.test(text)) {
      const billId = await sheets.appendBill(userId, state.bill);
      delete pending[userId];
      return safeReply(event.replyToken, [
        { type: 'text', text: `✅ บันทึกแล้ว (รหัส ${billId})\nยอดรวม ${fmt(state.bill.total)} บาท\n\nพิมพ์ "สรุป" เพื่อดูยอดรวม หรือส่งบิลใบใหม่ได้เลย` },
      ]);
    }
    // เข้าโหมดแก้ไข
    if (/^(แก้ไข|แก้|edit|✏️)/i.test(text) && state.stage === 'confirm') {
      state.stage = 'edit';
      return safeReply(event.replyToken, [
        {
          type: 'text',
          text:
            '✏️ พิมพ์สิ่งที่ต้องการแก้ เช่น:\n' +
            'ร้าน=7-Eleven\nยอด=120\nวันที่=2026-06-10\nหมวด=อาหารและเครื่องดื่ม\nภาษี=7.85\n\n' +
            '(แก้หลายอย่างพร้อมกันได้ คั่นด้วยขึ้นบรรทัดใหม่หรือคอมม่า)',
        },
      ]);
    }
    // ยกเลิก
    if (/^(ยกเลิก|cancel)/i.test(text)) {
      delete pending[userId];
      return safeReply(event.replyToken, [{ type: 'text', text: '❌ ยกเลิกบิลนี้แล้ว' }]);
    }
    // กำลังรับข้อมูลแก้ไข
    if (state.stage === 'edit') {
      const edits = parseEdit(text);
      if (Object.keys(edits).length === 0) {
        return safeReply(event.replyToken, [
          { type: 'text', text: 'ไม่เข้าใจรูปแบบ ลองใหม่ เช่น  ยอด=120  หรือ  ร้าน=โลตัส' },
        ]);
      }
      Object.assign(state.bill, edits);
      state.stage = 'confirm';
      return safeReply(event.replyToken, [billSummaryMessage(state.bill)]);
    }
  }

  // คำสั่งทั่วไป
  const cmd = parseCommand(text);
  if (cmd && cmd.type === 'help') {
    return safeReply(event.replyToken, [{ type: 'text', text: helpText() }]);
  }
  if (cmd && cmd.type === 'summary') {
    const s = await sheets.summarize(userId, cmd.from, cmd.to);
    return safeReply(event.replyToken, [{ type: 'text', text: summaryText(s, cmd.from, cmd.to) }]);
  }

  // ไม่เข้าเงื่อนไขใด
  return safeReply(event.replyToken, [{ type: 'text', text: helpText() }]);
}

// ---------- ข้อความสรุปบิล + ปุ่ม ----------
function billSummaryMessage(bill) {
  const lines = [];
  lines.push('🧾 ตรวจสอบข้อมูลบิล');
  lines.push('ร้าน: ' + (bill.store || '-'));
  lines.push('วันที่: ' + (bill.date || '-'));
  lines.push('หมวด: ' + (bill.category || '-'));
  if (bill.items && bill.items.length) {
    lines.push('รายการ:');
    for (const it of bill.items) {
      lines.push(`  • ${it.name} x${it.qty} = ${fmt(it.price)}`);
    }
  }
  if (bill.subtotal != null) lines.push('ยอดก่อนภาษี: ' + fmt(bill.subtotal));
  lines.push('ภาษี/VAT: ' + fmt(bill.vat));
  lines.push('💰 ยอดรวม: ' + fmt(bill.total) + ' บาท');
  lines.push('');
  lines.push('ถูกต้องไหม? กดยืนยัน หรือพิมพ์ "แก้ไข"');

  return {
    type: 'text',
    text: lines.join('\n'),
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '✅ ยืนยัน', text: 'ยืนยัน' } },
        { type: 'action', action: { type: 'message', label: '✏️ แก้ไข', text: 'แก้ไข' } },
        { type: 'action', action: { type: 'message', label: '❌ ยกเลิก', text: 'ยกเลิก' } },
      ],
    },
  };
}

function summaryText(s, from, to) {
  if (s.count === 0) {
    return `📊 ช่วง ${from} ถึง ${to}\nไม่พบบิลในช่วงนี้`;
  }
  const lines = [];
  lines.push(`📊 สรุปยอด ${from} ถึง ${to}`);
  lines.push(`จำนวนบิล: ${s.count} ใบ`);
  lines.push(`💰 ยอดรวมทั้งหมด: ${fmt(s.total)} บาท`);
  lines.push(`ภาษีรวม: ${fmt(s.vat)} บาท`);
  lines.push('');
  lines.push('แยกตามหมวด:');
  const cats = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, amt] of cats) {
    lines.push(`  • ${cat}: ${fmt(amt)}`);
  }
  return lines.join('\n');
}

function helpText() {
  return (
    '👋 วิธีใช้งาน\n\n' +
    '1) ส่งรูปบิล → บอทจะอ่านข้อมูลให้ตรวจสอบ\n' +
    '2) กด ✅ ยืนยัน เพื่อบันทึก หรือ ✏️ แก้ไข ถ้าข้อมูลผิด\n' +
    '3) ดูสรุปยอด พิมพ์ได้หลายแบบ เช่น:\n' +
    '   • สรุปวันนี้\n' +
    '   • สรุปเดือนนี้\n' +
    '   • สรุปเดือนที่แล้ว\n' +
    '   • สรุป 7 วัน\n' +
    '   • สรุป 1/6/2026 ถึง 15/6/2026'
  );
}

// ---------- utils ----------
function fmt(n) {
  if (n == null || n === '') return '0';
  return Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

// ดาวน์โหลดเนื้อหารูปจาก LINE เป็น Buffer
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ LINE bill bot listening on :${port}`));
