#!/usr/bin/env node
/*
 * make-films.mjs — Dựng "video dài" bằng cách GHÉP các Shorts theo nhóm chủ đề (chạy trên GitHub Actions).
 * Đọc film-assets/groups.json (mỗi nhóm: title, subtitle, clips[{id(driveId), title}]).
 * Mỗi phim: thẻ tiêu đề (film-assets/title{K}.png) + các clip đã chuẩn hoá 1080x1920 -> concat
 *   -> upload lên Google Drive -> tạo record "Video dài" trong bảng 16.3 (lịch nối tiếp, 10:00).
 * ENV: GOOGLE_OAUTH_* (Drive), LARK_APP_ID/SECRET/BASE_ID (+ LARK_DOMAIN), FILM_START (yyyy-mm-dd, mặc định 2026-08-04), ONLY (A,B,..).
 * Yêu cầu: ffmpeg trong PATH.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = process.cwd();
const WORK = path.join(process.env.RUNNER_TEMP || "/tmp", "films");
fs.mkdirSync(WORK, { recursive: true });
const FOLDER = "1fK4s35st32odkHf4GA5HIPTfwn6nfsON";
const DOMAIN = (process.env.LARK_DOMAIN || "https://open.larksuite.com").replace(/\/+$/, "");
const B = process.env.LARK_BASE_ID, T = "tblhOQoueE9qCv1S";
const groups = JSON.parse(fs.readFileSync(path.join(REPO, "film-assets/groups.json"), "utf8"));
const ONLY = (process.env.ONLY || "").split(",").map(s => s.trim()).filter(Boolean);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function gtoken() {
  const j = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN, grant_type: "refresh_token" }) })).json();
  if (!j.access_token) throw new Error("google token: " + JSON.stringify(j));
  return j.access_token;
}
async function ltoken() { return (await (await fetch(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }) })).json()).tenant_access_token; }

async function driveDownload(id, dest) {
  let last;
  for (let a = 1; a <= 4; a++) {
    try {
      const at = await gtoken();
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${at}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
      const sz = fs.statSync(dest).size; if (sz === 0) throw new Error("0 byte");
      return sz;
    } catch (e) { last = e.message; log(`    retry ${a} (${last})`); await new Promise(r => setTimeout(r, 2000 * a)); }
  }
  throw new Error("download fail: " + last);
}
async function driveUpload(file, name) {
  const at = await gtoken();
  const size = fs.statSync(file).size;
  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", { method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-Upload-Content-Type": "video/mp4" }, body: JSON.stringify({ name, parents: [FOLDER] }) });
  if (!init.ok) throw new Error(`upload init ${init.status}: ${await init.text()}`);
  const put = await fetch(init.headers.get("location"), { method: "PUT", headers: { "Content-Length": String(size), "Content-Type": "video/mp4" }, body: fs.createReadStream(file), duplex: "half" });
  const j = await put.json();
  if (!j.id) throw new Error(`upload ${put.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.id;
}

const NORM = "-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -b:a 128k";
const sh = (c) => execSync(c, { stdio: "ignore" });
const proper = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const TAGS = "sầu riêng, chăm sóc sầu riêng, phục hồi sầu riêng, cây sầu riêng suy, cứu bộ rễ, kỹ thuật sầu riêng, nông nghiệp tân nông, phân bón sầu riêng, vật tư nông nghiệp, tân nông";
async function createRecord(driveId, title, subtitle, schedMs) {
  const tk = await ltoken();
  const ytTitle = `${proper(title)} — ${subtitle} | Nông Nghiệp Tân Nông`.slice(0, 100);
  const desc = `${proper(title)} — ${subtitle}\n\nPhim tổng hợp từ vườn thực tế của Nông Nghiệp Tân Nông: kỹ thuật chăm sóc, phục hồi cây sầu riêng suy yếu, cứu bộ rễ, nuôi trái.\n\nTân Nông chuyên phân bón & thuốc bảo vệ thực vật nhập khẩu chính hãng, có kỹ sư tư vấn tận vườn qua Zalo. Cam kết hàng chính hãng — sai hoàn tiền gấp 10 lần.\n\n📞 Liên hệ Tân Nông để được kỹ sư tư vấn cho vườn của bạn.\n\n#nôngnghiệptânnông #sầuriêng #phụchồisầuriêng #tânnông`;
  const fields = { "Tiêu đề": ytTitle, "Mô tả": desc, "Tags": TAGS, "Loại": "Video dài", "Chế độ": "public", "Lịch đăng": schedMs, "Trạng thái": "Chờ đăng", "Drive ID": driveId, "STT": "PHIM" };
  const r = await (await fetch(`${DOMAIN}/open-apis/bitable/v1/apps/${B}/tables/${T}/records`, { method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }) })).json();
  if (r.code !== 0) throw new Error("Lark create: " + r.code + " " + r.msg);
  return r.data.record.record_id;
}

const baseDay = new Date(`${process.env.FILM_START || "2026-08-04"}T10:00:00+07:00`).getTime();
const DAY = 86400000;
let keys = Object.keys(groups); if (ONLY.length) keys = keys.filter(k => ONLY.includes(k));
const results = [];
for (let gi = 0; gi < keys.length; gi++) {
  const k = keys[gi], g = groups[k];
  const dir = path.join(WORK, k); fs.mkdirSync(dir, { recursive: true });
  log(`\n===== PHIM ${k}: ${g.title} (${g.clips.length} clip) =====`);
  const parts = [];
  try {
    const tcard = path.join(dir, "00_title.mp4");
    sh(`ffmpeg -y -loop 1 -i "${path.join(REPO, "film-assets", "title" + k + ".png")}" -f lavfi -t 3 -i anullsrc=channel_layout=stereo:sample_rate=48000 -vf "scale=1080:1920,setsar=1,fps=30" ${NORM} -shortest "${tcard}"`);
    parts.push(tcard); log("  ✓ thẻ tiêu đề");
    for (let i = 0; i < g.clips.length; i++) {
      const c = g.clips[i];
      const raw = path.join(dir, `raw${i}.mp4`), nrm = path.join(dir, `${String(i + 1).padStart(2, "0")}_n.mp4`);
      try {
        const sz = await driveDownload(c.id, raw);
        sh(`ffmpeg -y -i "${raw}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30" ${NORM} "${nrm}"`);
        fs.unlinkSync(raw); parts.push(nrm);
        log(`  ✓ [${i + 1}/${g.clips.length}] ${c.title.slice(0, 40)} (${(sz / 1048576).toFixed(0)}MB)`);
      } catch (e) { log(`  ✗ clip ${i + 1} lỗi: ${e.message} — bỏ qua`); }
    }
    if (parts.length < 2) throw new Error("không có clip hợp lệ");
    const listFile = path.join(dir, "list.txt");
    fs.writeFileSync(listFile, parts.map(p => `file '${p}'`).join("\n"));
    const out = path.join(WORK, `PHIM_${k}.mp4`);
    sh(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${out}"`);
    const mb = (fs.statSync(out).size / 1048576).toFixed(0);
    const durS = parseInt(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${out}"`).toString().trim());
    log(`  ✓ ghép: ${mb}MB ${Math.floor(durS / 60)}m${durS % 60}s`);
    const driveId = await driveUpload(out, `[TÂN NÔNG] ${g.title}.mp4`);
    log(`  ✓ upload Drive: ${driveId}`);
    const rid = await createRecord(driveId, g.title, g.subtitle, baseDay + gi * DAY);
    log(`  ✓ record Lark ${rid} | lịch ${new Date(baseDay + gi * DAY + 7 * 3600e3).toISOString().slice(0, 10)} 10:00`);
    results.push({ k, mb, durS, driveId });
    for (const p of parts) { try { fs.unlinkSync(p); } catch {} }
    try { fs.unlinkSync(out); } catch {}
  } catch (e) { log(`  ✗✗ PHIM ${k} THẤT BẠI: ${e.message}`); }
}
log(`\n✔✔ XONG ${results.length}/${keys.length} phim`);
for (const r of results) log(`   PHIM ${r.k}: ${r.mb}MB ${Math.floor(r.durS / 60)}m — Drive ${r.driveId}`);
if (results.length < keys.length) process.exit(1);
