// lib/reader.js
// อ่านบิลขนส่ง 2 ขั้นตอน:
// 1) OCR.space ดึงข้อความ (ภาษาไทย) จากรูป — มี retry กัน Engine 2 ฟรีไม่เสถียร
// 2) Groq (Llama) จัดข้อความให้เป็น JSON สำหรับงานขนส่งผ้าม่าน

const Jimp = require('jimp');

const OCR_KEY = process.env.OCR_SPACE_API_KEY;
const OCR_LANG = process.env.OCR_SPACE_LANGUAGE || 'auto';
const OCR_ENGINE = process.env.OCR_SPACE_ENGINE || '2';

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ย่อรูปให้เล็กพอ (Engine 2 ฟรีชอบรูปไม่ใหญ่) ----------
async function prepareImage(buffer) {
  const img = await Jimp.read(buffer);
  const MAX = 1600;
  if (img.bitmap.width > MAX || img.bitmap.height > MAX) {
    img.scaleToFit(MAX, MAX);
  }
  let quality = 75;
  let out = await img.quality(quality).getBufferAsync(Jimp.MIME_JPEG);
  while (out.length > 900 * 1000 && quality > 30) {
    quality -= 15;
    out = await img.quality(quality).getBufferAsync(Jimp.MIME_JPEG);
  }
  return out;
}

// ---------- เรียก OCR.space 1 ครั้ง ----------
async function ocrOnce(base64, opts) {
  const body = new URLSearchParams();
  body.set('base64Image', base64);
  body.set('language', OCR_LANG);
  body.set('OCREngine', OCR_ENGINE);
  body.set('isOverlayRequired', 'false');
  if (opts.detectOrientation) body.set('detectOrientation', 'true');
  if (opts.scale) body.set('scale', 'true');

  const res = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { apikey: OCR_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return res.json();
}

// ---------- ขั้นที่ 1: OCR.space (ลองซ้ำหลายครั้ง) ----------
async function ocrSpace(buffer) {
  const jpeg = await prepareImage(buffer);
  const base64 = 'data:image/jpeg;base64,' + jpeg.toString('base64');

  // สลับพารามิเตอร์ + ลองซ้ำ กัน Engine 2 ฟรีล้มเป็นพักๆ (E502/E500)
  const variants = [
    { detectOrientation: true, scale: false },
    { detectOrientation: false, scale: false },
    { detectOrientation: true, scale: true },
  ];
  let lastErr = '';
  for (let i = 0; i < variants.length; i++) {
    try {
      const data = await ocrOnce(base64, variants[i]);
      if (data.IsErroredOnProcessing) {
        lastErr = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(' ') : (data.ErrorMessage || 'OCR error');
        await sleep(1300);
        continue;
      }
      const text = (data.ParsedResults || []).map((r) => r.ParsedText || '').join('\n').trim();
      if (!text) { lastErr = 'อ่านตัวอักษรไม่ได้'; await sleep(800); continue; }
      return text;
    } catch (e) {
      lastErr = e.message;
      await sleep(1300);
    }
  }
  throw new Error('OCR ล้มเหลว: ' + (lastErr || 'ไม่ทราบสาเหตุ') + ' — ลองถ่ายใหม่ให้ชัด/ตรง แล้วส่งซ้ำอีกครั้ง');
}

// ---------- ขั้นที่ 2: Groq จัดโครงสร้าง ----------
function extractJson(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Groq ไม่ได้ตอบ JSON');
  return JSON.parse(t.slice(start, end + 1));
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[, ฿$]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

function normPayment(v) {
  const s = (v || '').toString();
  if (/ปลายทาง|cod/i.test(s)) return 'เก็บปลายทาง';
  if (/ต้นทาง/i.test(s)) return 'เก็บต้นทาง';
  if (/เครดิต|credit/i.test(s)) return 'เครดิต';
  return str(v);
}

async function structureWithGroq(ocrText) {
  const system =
    'คุณคือผู้ช่วยอ่านใบรับ-ส่งพัสดุของบริษัทขนส่งในไทย (ลูกค้าเป็นโรงงานผ้าม่าน ส่งผ้าให้ร้านสาขา) ' +
    'ข้อความมาจาก OCR อาจมีตัวสะกดผิดบ้าง ให้ตอบกลับเป็น JSON เท่านั้น';
  const user = `ข้อความจากบิลขนส่ง (OCR):
"""
${ocrText}
"""

จัดเป็น JSON โครงสร้างนี้ (หาไม่เจอให้ใส่ null):
{
  "date": "วันที่ในรูป YYYY-MM-DD (ถ้าเป็น พ.ศ. ให้ลบ 543 เป็น ค.ศ.) หรือ null",
  "courier": "ชื่อบริษัทขนส่ง (มักอยู่หัวบิล เช่น ไชยรักษ์เอ็กซ์เพรส, ภัทรขนส่ง) หรือ null",
  "bill_no": "เลขที่บิล/เลขที่เอกสาร หรือ null",
  "branch": "ชื่อจังหวัด/อำเภอ/เมืองปลายทางที่เขียนไว้ (คือชื่อร้านสาขา เช่น ยะลา ปัตตานี หาดใหญ่ เบตง) หรือ null",
  "job_owner": "ชื่อผู้รับ/ชื่อคนที่เขียนไว้ในบิล (เจ้าของงาน) หรือ null",
  "job_name": "ชื่องาน/ข้อความกำกับงานถ้ามี หรือ null",
  "item": "รายการสินค้าที่ส่ง เช่น ผ้าม้วนยาว หรือ null",
  "qty": จำนวนชิ้น(ตัวเลข) หรือ null,
  "shipping_cost": ยอดค่าขนส่งรวม(ตัวเลข) หรือ null,
  "payment": "วิธีเก็บเงิน: เก็บปลายทาง / เก็บต้นทาง / เครดิต หรือ null"
}
กฎ: ตัวเลขเป็นตัวเลขล้วน ไม่มีคอมม่า/สกุลเงิน ตอบ JSON ที่ valid เท่านั้น`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Groq error: ' + (data.error.message || JSON.stringify(data.error)));
  const content = data.choices && data.choices[0] && data.choices[0].message.content;
  return extractJson(content);
}

/**
 * อ่านบิลขนส่งจาก buffer รูปภาพ
 */
async function readBill(buffer, _mimeType) {
  const ocrText = await ocrSpace(buffer);
  const d = await structureWithGroq(ocrText);
  return {
    date: str(d.date),
    courier: str(d.courier),
    bill_no: str(d.bill_no),
    branch: str(d.branch),
    job_owner: str(d.job_owner),
    job_name: str(d.job_name),
    item: str(d.item),
    qty: toNumber(d.qty),
    shipping_cost: toNumber(d.shipping_cost),
    payment: normPayment(d.payment),
  };
}

module.exports = { readBill };
