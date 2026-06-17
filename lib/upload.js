// lib/upload.js
// อัปโหลดรูปบิลขึ้น Cloudinary (ฟรี ไม่ต้องผูกบัตร) แยกโฟลเดอร์ตามเดือน คืน URL ถาวร
// ทำงานเมื่อมีคีย์ครบ ถ้าไม่มีจะคืน null (ข้ามการเก็บรูป)

const crypto = require('crypto');

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const KEY = process.env.CLOUDINARY_API_KEY;
const SECRET = process.env.CLOUDINARY_API_SECRET;

function configured() {
  return !!(CLOUD && KEY && SECRET);
}

/**
 * อัปโหลดรูปจาก buffer -> คืน secure_url (https) หรือ null ถ้าไม่ได้ตั้งค่า
 * @param {Buffer} buffer
 * @param {string} folderSuffix เช่น "2026-06"
 */
async function uploadImage(buffer, folderSuffix) {
  if (!configured()) return null;
  const ts = Math.floor(Date.now() / 1000);
  const folder = 'bills/' + (folderSuffix || 'misc');
  // ลายเซ็น: พารามิเตอร์เรียงตามตัวอักษร (folder, timestamp) + api_secret
  const toSign = `folder=${folder}&timestamp=${ts}`;
  const signature = crypto.createHash('sha1').update(toSign + SECRET).digest('hex');

  const form = new FormData();
  form.set('file', 'data:image/jpeg;base64,' + buffer.toString('base64'));
  form.set('api_key', KEY);
  form.set('timestamp', String(ts));
  form.set('folder', folder);
  form.set('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, { method: 'POST', body: form });
  const data = await res.json();
  if (data.secure_url) return data.secure_url;
  throw new Error('อัปโหลดรูปไม่สำเร็จ: ' + ((data.error && data.error.message) || 'ไม่ทราบสาเหตุ'));
}

module.exports = { uploadImage, configured };
