// lib/sheets.js
// บันทึก/อ่านข้อมูลบิลใน Google Sheets ผ่าน service account

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Bills';

// หัวตาราง (คอลัมน์ A-J)
const HEADER = [
  'timestamp', // เวลาที่บันทึก (ISO)
  'user_id',   // LINE user id
  'date',      // วันที่บิล YYYY-MM-DD
  'store',     // ร้าน
  'category',  // หมวดหมู่
  'items',     // รายการสินค้า (รวมเป็นข้อความ)
  'subtotal',  // ยอดก่อนภาษี
  'vat',       // ภาษี
  'total',     // ยอดรวมสุทธิ
  'bill_id',   // รหัสบิล (ใช้อ้างอิงตอนแก้ไข)
];

let _sheets = null;

function getClient() {
  if (_sheets) return _sheets;
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

// แปลง items array เป็นข้อความอ่านง่าย
function itemsToText(items) {
  if (!items || !items.length) return '';
  return items
    .map((it) => `${it.name} x${it.qty} = ${it.price}`)
    .join('; ');
}

// สร้างหัวตารางถ้ายังไม่มี
async function ensureHeader() {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:J1`,
  });
  const row = res.data.values && res.data.values[0];
  if (!row || row.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  }
}

/**
 * บันทึกบิล 1 รายการ
 * @returns {Promise<string>} bill_id
 */
async function appendBill(userId, bill) {
  await ensureHeader();
  const sheets = getClient();
  const billId = 'B' + Date.now().toString(36).toUpperCase();
  const row = [
    new Date().toISOString(),
    userId,
    bill.date || '',
    bill.store || '',
    bill.category || '',
    itemsToText(bill.items),
    bill.subtotal ?? '',
    bill.vat ?? 0,
    bill.total ?? '',
    billId,
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return billId;
}

/**
 * ดึงบิลทั้งหมดของ user (เป็น array ของ object)
 */
async function getBills(userId) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:J`,
  });
  const rows = res.data.values || [];
  return rows
    .map((r) => ({
      timestamp: r[0] || '',
      user_id: r[1] || '',
      date: r[2] || '',
      store: r[3] || '',
      category: r[4] || '',
      items: r[5] || '',
      subtotal: r[6] || '',
      vat: parseFloat(r[7]) || 0,
      total: parseFloat(r[8]) || 0,
    }))
    .filter((b) => !userId || b.user_id === userId);
}

/**
 * สรุปยอดในช่วงวันที่ [from, to] (รวมปลายทั้งสองข้าง) เป็น YYYY-MM-DD
 */
async function summarize(userId, from, to) {
  const bills = await getBills(userId);
  const inRange = bills.filter((b) => b.date && b.date >= from && b.date <= to);
  let total = 0;
  let vat = 0;
  const byCategory = {};
  for (const b of inRange) {
    total += b.total || 0;
    vat += b.vat || 0;
    const c = b.category || 'อื่นๆ';
    byCategory[c] = (byCategory[c] || 0) + (b.total || 0);
  }
  return { count: inRange.length, total, vat, byCategory, bills: inRange };
}

module.exports = { appendBill, getBills, summarize, itemsToText };
