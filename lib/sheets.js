// lib/sheets.js
// บันทึก/อ่าน/สรุปข้อมูลบิลขนส่งใน Google Sheets ผ่าน service account
// - retry กันการเชื่อมต่อ Google หลุดชั่วคราว (Premature close / ECONNRESET)
// - แคชสั้นๆ + เช็กบิลซ้ำอ่านแค่คอลัมน์เดียว เพื่อลดการอ่านข้อมูลเกินจำเป็น

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Bills';
const CACHE_MS = 15000; // อายุแคช (มิลลิวินาที)

// หัวตาราง (คอลัมน์ A-Q)
const HEADER = [
  'timestamp',        // A เวลาที่บันทึก
  'user_id',          // B LINE user id
  'date',             // C วันที่บิล
  'branch',           // D ร้านสาขา
  'job_owner',        // E เจ้าของงาน/ชื่องาน
  'fabric_company',   // F บริษัทผ้า
  'item_type',        // G ประเภทสินค้า (ผ้าม่าน/อุปกรณ์/อื่นๆ)
  'item',             // H รายการ/ชื่อสินค้า
  'fabric_code',      // I รหัสผ้า
  'qty',              // J จำนวน
  'unit',             // K หน่วย (ห่อ/ม้วน/เมตร/...)
  'courier',          // L บริษัทขนส่ง
  'bill_no',          // M เลขที่บิล
  'shipping_cost',    // N ค่าขนส่ง (บาท)
  'payment',          // O วิธีเก็บเงิน
  'image_url',        // P ลิงก์รูปบิล
  'bill_id',          // Q รหัสบิล
];

// ---------- retry กันเน็ตหลุดชั่วคราว ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /premature close|econnreset|etimedout|socket hang up|eai_again|enotfound|network|fetch failed|terminated|aborted|esockettimedout|read econn/i;
async function retry(fn, n = 4) {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const msg = (e && (e.message || e.code) || '').toString();
      if (i === n - 1 || !TRANSIENT.test(msg)) throw e;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}

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

// แปลงวันที่ให้เป็น ค.ศ. เสมอ (ถ้าปี >= 2400 ถือเป็น พ.ศ. ให้ลบ 543) กันข้อมูลปนกัน
function ceDate(s) {
  s = String(s || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  let y = parseInt(m[1], 10);
  if (y >= 2400) y -= 543;
  return y + '-' + m[2] + '-' + m[3];
}

function sheetUrl() {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
}

// ---------- แคช (ลดการอ่านซ้ำ) ----------
let _rowsCache = { at: 0, rows: null };   // แถวดิบทั้งตาราง A2:Q
let _billNoCache = { at: 0, set: null };  // ชุดเลขที่บิล (คอลัมน์ M)
function clearCache() { _rowsCache = { at: 0, rows: null }; _billNoCache = { at: 0, set: null }; }
const fresh = (c) => c && (Date.now() - c.at < CACHE_MS);

// ---------- ดูแลแท็บ (sheet/tab) ----------
async function listSheetProps() {
  const sheets = getClient();
  const meta = await retry(() => sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties(sheetId,title)',
  }));
  return (meta.data.sheets || []).map((s) => s.properties);
}

async function getSheetId(title) {
  const props = await listSheetProps();
  const f = props.find((p) => p.title === title);
  return f ? f.sheetId : null;
}

// สร้างแท็บอัตโนมัติถ้ายังไม่มี + ใส่หัวตาราง (ทำงานจริงครั้งเดียว)
let _ensured = false;
async function ensureSheet() {
  if (_ensured) return;
  const sheets = getClient();
  const id = await getSheetId(SHEET_NAME);
  if (id === null) {
    await retry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    }));
  }
  await ensureHeader();
  _ensured = true;
}

async function ensureHeader() {
  const sheets = getClient();
  const res = await retry(() => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:Q1` }));
  const row = res.data.values && res.data.values[0];
  if (!row || row.length === 0) {
    await retry(() => sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW', requestBody: { values: [HEADER] },
    }));
  }
}

async function appendBill(userId, b) {
  await ensureSheet();
  const sheets = getClient();
  const billId = 'B' + Date.now().toString(36).toUpperCase();
  const row = [
    new Date().toISOString(), userId,
    ceDate(b.date), b.branch || '', b.job_owner || '', b.fabric_company || '',
    b.item_type || '', b.item || '', b.fabric_code || '', b.qty ?? '', b.unit || '',
    b.courier || '', b.bill_no || '', b.shipping_cost ?? '', b.payment || '', b.image_url || '', billId,
  ];
  await retry(() => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  }));
  clearCache(); // มีบิลใหม่ ล้างแคชให้รอบหน้าอ่านสด
  return billId;
}

// อ่านแถวดิบทั้งตาราง (ใช้แคชถ้ายังสด)
async function getRawRows() {
  if (fresh(_rowsCache) && _rowsCache.rows) return _rowsCache.rows;
  await ensureSheet();
  const sheets = getClient();
  const res = await retry(() => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A2:Q` }));
  const rows = res.data.values || [];
  _rowsCache = { at: Date.now(), rows };
  return rows;
}

async function getBills(userId) {
  const rows = await getRawRows();
  return rows.map((r) => ({
    timestamp: r[0] || '', user_id: r[1] || '', date: ceDate(r[2]),
    branch: r[3] || '', job_owner: r[4] || '', fabric_company: r[5] || '',
    item_type: r[6] || '', item: r[7] || '', fabric_code: r[8] || '',
    qty: parseFloat(r[9]) || 0, unit: r[10] || '',
    courier: r[11] || '', bill_no: r[12] || '', shipping_cost: parseFloat(r[13]) || 0,
    payment: r[14] || '', image_url: r[15] || '', bill_id: r[16] || '',
  })).filter((b) => !userId || b.user_id === userId);
}

// เช็คว่าเลขที่บิลนี้เคยบันทึกแล้วหรือยัง — อ่านแค่คอลัมน์ M (เลขที่บิล) + แคช
async function billNoExists(billNo) {
  if (!billNo) return false;
  const target = String(billNo).trim();
  if (!target) return false;
  let set = (fresh(_billNoCache) && _billNoCache.set) ? _billNoCache.set : null;
  if (!set) {
    await ensureSheet();
    const sheets = getClient();
    const res = await retry(() => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!M2:M` }));
    set = new Set((res.data.values || []).map((r) => (r[0] || '').trim()).filter(Boolean));
    _billNoCache = { at: Date.now(), set };
  }
  return set.has(target);
}

async function recentBills(userId, n = 5) {
  const bills = await getBills(userId);
  return bills.slice(-n).reverse();
}

// groupBy: 'branch' | 'courier' | 'fabric_company' | null
async function summarize(userId, from, to, groupBy) {
  const bills = await getBills(userId);
  const inRange = bills.filter((b) => b.date && b.date >= from && b.date <= to);
  let total = 0, qty = 0;
  const groups = {};
  for (const b of inRange) {
    total += b.shipping_cost || 0; qty += b.qty || 0;
    if (groupBy) {
      const key = (b[groupBy] || '(ไม่ระบุ)').trim() || '(ไม่ระบุ)';
      if (!groups[key]) groups[key] = { count: 0, cost: 0, qty: 0 };
      groups[key].count += 1; groups[key].cost += b.shipping_cost || 0; groups[key].qty += b.qty || 0;
    }
  }
  return { count: inRange.length, total, qty, groups, bills: inRange };
}

// ---------- สำรองข้อมูล: คัดลอกแท็บปัจจุบันเป็นแท็บใหม่ติดวันเวลา ----------
async function backup() {
  await ensureSheet();
  const sheets = getClient();
  const srcId = await getSheetId(SHEET_NAME);
  if (srcId === null) throw new Error('ไม่พบแท็บ ' + SHEET_NAME);
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const title = `Backup_${SHEET_NAME}_${stamp}`;
  await retry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ duplicateSheet: { sourceSheetId: srcId, newSheetName: title } }] },
  }));
  return title;
}

module.exports = { appendBill, getBills, recentBills, summarize, sheetUrl, billNoExists, backup, clearCache, HEADER, SHEET_NAME };
