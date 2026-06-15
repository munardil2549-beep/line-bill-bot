// lib/reader.js
// อ่านบิล 2 ขั้นตอน:
// 1) OCR.space ดึงข้อความ (ภาษาไทย) จากรูป
// 2) Groq (Llama) จัดข้อความให้เป็น JSON ที่มีโครงสร้าง
// ทั้งคู่ฟรี ไม่ต้องผูกบัตร

const Jimp = require('jimp');

const OCR_KEY = process.env.OCR_SPACE_API_KEY;
const OCR_LANG = process.env.OCR_SPACE_LANGUAGE || 'tha';
const OCR_ENGINE = process.env.OCR_SPACE_ENGINE || '1';

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const CATEGORIES = [
  'อาหารและเครื่องดื่ม',
  'ของใช้ในบ้าน',
  'เดินทาง/น้ำมัน',
  'สุขภาพ/ยา',
  'ช้อปปิ้ง',
  'ค่าสาธารณูปโภค',
  'บันเทิง',
  'อื่นๆ',
];

// ---------- ย่อรูปให้ไม่เกิน ~1MB (ข้อจำกัด OCR.space free tier) ----------
async function prepareImage(buffer) {
  const img = await Jimp.read(buffer);
  const MAX = 2000;
  if (img.bitmap.width > MAX || img.bitmap.height > MAX) {
    img.scaleToFit(MAX, MAX);
  }
  let quality = 80;
  let out = await img.quality(quality).getBufferAsync(Jimp.MIME_JPEG);
  while (out.length > 1000 * 1000 && quality > 30) {
    quality -= 15;
    out = await img.quality(quality).getBufferAsync(Jimp.MIME_JPEG);
  }
  return out;
}

// ---------- ขั้นที่ 1: OCR.space ----------
async function ocrSpace(buffer) {
  const jpeg = await prepareImage(buffer);
  const base64 = 'data:image/jpeg;base64,' + jpeg.toString('base64');

  const body = new URLSearchParams();
  body.set('base64Image', base64);
  body.set('language', OCR_LANG);
  body.set('OCREngine', OCR_ENGINE);
  body.set('isOverlayRequired', 'false');
  body.set('scale', 'true');
  body.set('detectOrientation', 'true');

  const res = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { apikey: OCR_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();

  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(' ') : data.ErrorMessage;
    throw new Error('OCR ล้มเหลว: ' + (msg || 'ไม่ทราบสาเหตุ'));
  }
  const text = (data.ParsedResults || []).map((r) => r.ParsedText || '').join('\n').trim();
  if (!text) throw new Error('อ่านตัวอักษรจากรูปไม่ได้ ลองถ่ายให้ชัดขึ้น');
  return text;
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

async function structureWithGroq(ocrText) {
  const system =
    'คุณคือผู้ช่วยจัดข้อมูลใบเสร็จ/บิล จากข้อความ OCR (อาจมีตัวสะกดผิดบ้าง) ' +
    'ให้ตอบกลับเป็น JSON เท่านั้น';
  const user = `ข้อความจากบิล (OCR):
"""
${ocrText}
"""

จัดเป็น JSON โครงสร้างนี้:
{
  "store": "ชื่อร้าน/ผู้ขาย หรือ null",
  "date": "YYYY-MM-DD (ถ้าเป็น พ.ศ. ให้ลบ 543 เป็น ค.ศ.) หรือ null",
  "items": [ { "name": "ชื่อสินค้า", "qty": ตัวเลข, "price": ราคารวมรายการ(ตัวเลข) } ],
  "category": "เลือก 1 หมวดจาก: ${CATEGORIES.join(', ')}",
  "vat": ภาษีมูลค่าเพิ่ม(ตัวเลข) หรือ 0,
  "subtotal": ยอดก่อนภาษี(ตัวเลข) หรือ null,
  "total": ยอดรวมสุทธิ(ตัวเลข) หรือ null
}
กฎ: ตัวเลขเป็นตัวเลขล้วน ไม่มีคอมม่า/สกุลเงิน ตอบ JSON ที่ valid เท่านั้น`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + GROQ_KEY,
      'Content-Type': 'application/json',
    },
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
 * อ่านบิลจาก buffer รูปภาพ (signature เดิม ใช้แทน gemini ได้เลย)
 */
async function readBill(buffer, _mimeType) {
  const ocrText = await ocrSpace(buffer);
  const data = await structureWithGroq(ocrText);

  const items = Array.isArray(data.items)
    ? data.items.map((it) => ({
        name: String(it.name || '').trim(),
        qty: toNumber(it.qty) ?? 1,
        price: toNumber(it.price) ?? 0,
      }))
    : [];

  return {
    store: data.store ? String(data.store).trim() : null,
    date: data.date ? String(data.date).trim() : null,
    items,
    category: data.category ? String(data.category).trim() : 'อื่นๆ',
    vat: toNumber(data.vat) ?? 0,
    subtotal: toNumber(data.subtotal),
    total: toNumber(data.total),
  };
}

module.exports = { readBill, CATEGORIES };
