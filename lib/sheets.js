// lib/sheets.js
// บันทึก/อ่าน/สรุปข้อมูลบิลขนส่งใน Google Sheets ผ่าน service account

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Bills';

// หัวตาราง (คอลัมน์ A-M)
const HEADER = [
  'timestamp',      // A เวลาที่บันทึก (ISO)
  'user_id',        // B LINE user id
  'date',           // C วันที่บิล YYYY-MM-DD
  'branch',         // D ร้านสาขา
  'job_owner',      // E เจ้าของงาน
  'job_name',       // F ชื่องาน
  'courier',        // G บริษัทขนส่ง
  'bill_no',        // H เลขที่บิล
  'item',           // I รายการสินค้า
  'qty',            // J จำนวน (ชิ้น)
  'shipping_cost',  // K ค่าขนส่ง (บาท)
  'payment',        // L วิธีเก็บเงิน
  'bill_id',        // M รหัสบิล
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

// ลิงก์เปิดสเปรดชีต
function sheetUrl() {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
}

// สร้างหัวตารางถ้ายังไม่มี
async function ensureHeader() {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:M1`,
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
 * บันทึกบิล 1 รายการ -> คืน bill_id
 */
async function appendBill(userId, b) {
  await ensureHeader();
  const sheets = getClient();
  const billId = 'B' + Date.now().toString(36).toUpperCase();
  const row = [
    new Date().toISOString(),
    userId,
    b.date || '',
    b.branch || '',
    b.job_owner || '',
    b.job_name || '',
    b.courier || '',
    b.bill_no || '',
    b.item || '',
    b.qty ?? '',
    b.shipping_cost ?? '',
    b.payment || '',
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
 * ดึงบิลทั้งหมด (กรองตาม userId ถ้าระบุ) -> array ของ object
 */
async function getBills(userId) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:M`,
  });
  const rows = res.data.values || [];
  return rows
    .map((r) => ({
      timestamp: r[0] || '',
      user_id: r[1] || '',
      date: r[2] || '',
      branch: r[3] || '',
      job_owner: r[4] || '',
      job_name: r[5] || '',
      courier: r[6] || '',
      bill_no: r[7] || '',
      item: r[8] || '',
      qty: parseFloat(r[9]) || 0,
      shipping_cost: parseFloat(r[10]) || 0,
      payment: r[11] || '',
      bill_id: r[12] || '',
    }))
    .filter((b) => !userId || b.user_id === userId);
}

// บิลล่าสุด n รายการ (ใหม่สุดก่อน)
async function recentBills(userId, n = 5) {
  const bills = await getBills(userId);
  return bills.slice(-n).reverse();
}

/**
 * สรุปยอดค่าขนส่งในช่วง [from, to] (YYYY-MM-DD, รวมปลายทั้งสอง)
 * groupBy: 'branch' | 'courier' | null(รวมทั้งหมด)
 */
async function summarize(userId, from, to, groupBy) {
  const bills = await getBills(userId);
  const inRange = bills.filter((b) => b.date && b.date >= from && b.date <= to);
  let total = 0;
  let qty = 0;
  const groups = {};
  for (const b of inRange) {
    total += b.shipping_cost || 0;
    qty += b.qty || 0;
    if (groupBy) {
      const key = (b[groupBy] || '(ไม่ระบุ)').trim() || '(ไม่ระบุ)';
      if (!groups[key]) groups[key] = { count: 0, cost: 0, qty: 0 };
      groups[key].count += 1;
      groups[key].cost += b.shipping_cost || 0;
      groups[key].qty += b.qty || 0;
    }
  }
  return { count: inRange.length, total, qty, groups, bills: inRange };
}

module.exports = { appendBill, getBills, recentBills, summarize, sheetUrl, HEADER };
