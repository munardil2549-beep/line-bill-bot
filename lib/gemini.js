// lib/gemini.js
// อ่านบิลจากรูปภาพด้วย Google Gemini Vision แล้วคืนค่าเป็น JSON ที่มีโครงสร้าง

const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// หมวดหมู่ค่าใช้จ่ายมาตรฐาน (ปรับเพิ่ม/ลดได้ตามต้องการ)
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

const PROMPT = `คุณคือผู้ช่วยอ่านใบเสร็จ/บิลภาษาไทยและอังกฤษ
อ่านข้อมูลจากรูปบิลนี้แล้วตอบกลับเป็น JSON เท่านั้น (ห้ามมีข้อความอื่นหรือ markdown code fence)

โครงสร้าง JSON:
{
  "store": "ชื่อร้าน/ผู้ขาย หรือ null ถ้าหาไม่เจอ",
  "date": "วันที่ในรูปแบบ YYYY-MM-DD (แปลง พ.ศ. เป็น ค.ศ. โดยลบ 543) หรือ null ถ้าหาไม่เจอ",
  "items": [
    { "name": "ชื่อสินค้า", "qty": จำนวน(ตัวเลข), "price": ราคารวมของรายการนั้น(ตัวเลข) }
  ],
  "category": "เลือก 1 หมวดที่เหมาะสมที่สุดจาก: ${CATEGORIES.join(', ')}",
  "vat": ยอดภาษีมูลค่าเพิ่ม(ตัวเลข) หรือ 0 ถ้าไม่มี,
  "subtotal": ยอดก่อนภาษี(ตัวเลข) หรือ null,
  "total": ยอดรวมสุทธิที่ต้องจ่าย(ตัวเลข)
}

กฎ:
- ตัวเลขทุกค่าเป็นตัวเลขล้วน ไม่มีเครื่องหมายคอมม่าหรือสกุลเงิน
- ถ้าอ่านยอดรวมไม่ได้เลย ให้ total เป็น null
- ตอบเป็น JSON ที่ valid เท่านั้น`;

// แปลง buffer รูปเป็น part สำหรับ Gemini
function imagePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType: mimeType || 'image/jpeg',
    },
  };
}

// ดึง JSON ออกจากข้อความตอบกลับ (เผื่อมี code fence ติดมา)
function extractJson(text) {
  if (!text) throw new Error('Gemini ไม่ได้ตอบข้อมูลกลับมา');
  let t = text.trim();
  // ตัด ```json ... ``` ออกถ้ามี
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // หา { ... } ก้อนแรกถึงก้อนสุดท้าย
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('ไม่พบ JSON ในคำตอบของ Gemini');
  return JSON.parse(t.slice(start, end + 1));
}

// normalize ค่าให้เป็นตัวเลข/รูปแบบที่ถูกต้อง
function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[, ฿$]/g, ''));
  return Number.isNaN(n) ? null : n;
}

/**
 * อ่านบิลจาก buffer รูปภาพ
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<object>} ข้อมูลบิลที่อ่านได้
 */
async function readBill(buffer, mimeType) {
  const model = genAI.getGenerativeModel({ model: MODEL });
  const result = await model.generateContent([PROMPT, imagePart(buffer, mimeType)]);
  const text = result.response.text();
  const data = extractJson(text);

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
