#!/usr/bin/env node
/*
 * post-drive-to-youtube.mjs — Đăng video THẲNG từ Google Drive lên YouTube (không nhồi qua Lark).
 *
 * Đọc bảng 16.3 (Lark Base) các dòng Trạng thái = "Chờ đăng" CÓ "Drive ID" và "Lịch đăng" tới hạn,
 * lấy N dòng sớm nhất (mặc định 1/ lần chạy), rồi với mỗi dòng:
 *   1) tải video từ Drive (GOOGLE_OAUTH_*) về đĩa tạm,
 *   2) resumable upload lên YouTube (YT_OAUTH_*) — tiêu đề/mô tả/tags từ record, hẹn giờ theo "Lịch đăng",
 *   3) đặt thumbnail từ "Cover Drive ID" (nếu có + kênh đã xác minh),
 *   4) ghi ngược Trạng thái=Đã đăng / Video ID / Link / Ngày đăng (lỗi → Trạng thái=Lỗi + Ghi chú lỗi).
 *
 * ENV: LARK_APP_ID, LARK_APP_SECRET, LARK_BASE_ID, LARK_DOMAIN?, TABLE_POST?(mặc định dò "16.3"),
 *      YT_OAUTH_CLIENT_ID, YT_OAUTH_CLIENT_SECRET, YT_OAUTH_REFRESH_TOKEN,
 *      GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN,
 *      YT_CATEGORY_ID?(22), COUNT?(1), DRY_RUN?
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DOMAIN = (process.env.LARK_DOMAIN || "https://open.larksuite.com").replace(/\/+$/, "");
const BASE = process.env.LARK_BASE_ID;
const COUNT = parseInt(process.env.COUNT || "1", 10);
const DRY = !!process.env.DRY_RUN;
const FORCE = ["1", "true", "yes"].includes(String(process.env.FORCE || "").toLowerCase());   // bỏ qua điều kiện "Lịch đăng tới hạn"
const CATEGORY = process.env.YT_CATEGORY_ID || "22";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m) => { console.error("✖ " + m); process.exit(1); };

for (const k of ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_BASE_ID", "YT_OAUTH_CLIENT_ID", "YT_OAUTH_CLIENT_SECRET", "YT_OAUTH_REFRESH_TOKEN", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"])
  if (!process.env[k]) die("Thiếu ENV " + k);

// ---------- tokens ----------
let _lark = 0, _larkTok = "";
async function larkToken() {
  if (Date.now() < _lark) return _larkTok;
  const j = await (await fetch(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }) })).json();
  _larkTok = j.tenant_access_token; _lark = Date.now() + 90 * 60e3; return _larkTok;
}
async function oauthToken(prefix) {
  const j = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env[`${prefix}_CLIENT_ID`], client_secret: process.env[`${prefix}_CLIENT_SECRET`], refresh_token: process.env[`${prefix}_REFRESH_TOKEN`], grant_type: "refresh_token" }) })).json();
  if (!j.access_token) throw new Error(`${prefix} refresh lỗi: ${JSON.stringify(j)}`);
  return j.access_token;
}

// ---------- Lark helpers ----------
async function larkApi(method, apiPath, body) {
  const r = await fetch(`${DOMAIN}${apiPath}`, { method, headers: { Authorization: `Bearer ${await larkToken()}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`Lark ${apiPath}: ${j.code} ${j.msg}`);
  return j.data;
}
async function resolveTable() {
  if (process.env.TABLE_POST) return process.env.TABLE_POST;
  const d = await larkApi("GET", `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`);
  const t = (d.items || []).find((x) => x.name.startsWith("16.3"));
  if (!t) die('Không thấy bảng "16.3"');
  return t.table_id;
}
const val = (f) => Array.isArray(f) ? (f[0]?.text ?? "") : (f?.text ?? f ?? "");

// ---------- main ----------
const TABLE = await resolveTable();
const TP = () => `/open-apis/bitable/v1/apps/${BASE}/tables/${TABLE}`;
const updateRow = (rid, fields) => larkApi("PUT", `${TP()}/records/${rid}`, { fields });

// gom tất cả record
const all = [];
{ let pt = null; do { const qs = new URLSearchParams({ page_size: "200" }); if (pt) qs.set("page_token", pt); const d = await larkApi("GET", `${TP()}/records?${qs}`); all.push(...(d.items || [])); pt = d.has_more ? d.page_token : null; } while (pt); }

const now = Date.now();
const due = all
  .map((r) => ({ id: r.record_id, f: r.fields }))
  // CHỈ đăng "Video dài" (mỗi ngày 1 video dài). Shorts giữ làm nguyên liệu ghép compilation, không tự đăng.
  .filter((r) => String(val(r.f["Trạng thái"])) === "Chờ đăng" && val(r.f["Drive ID"]) && String(val(r.f["Loại"])) === "Video dài" && (FORCE || !r.f["Lịch đăng"] || Number(r.f["Lịch đăng"]) <= now + 16 * 60 * 60e3))
  .sort((a, b) => (Number(a.f["Lịch đăng"] || 0) - Number(b.f["Lịch đăng"] || 0)) || (parseInt(val(a.f["STT"]) || "0") - parseInt(val(b.f["STT"]) || "0")));

log(`Có ${due.length} video tới hạn (Chờ đăng + Drive ID + Lịch đăng ≤ giờ). Sẽ đăng ${Math.min(COUNT, due.length)}.`);
if (!due.length) { log("Không có video nào tới hạn hôm nay."); process.exit(0); }

const batch = due.slice(0, COUNT);
for (const row of batch) {
  const f = row.f;
  const title = val(f["Tiêu đề"]) || "Video Tân Nông";
  const driveId = val(f["Drive ID"]);
  const coverId = val(f["Cover Drive ID"]);
  const schedMs = Number(f["Lịch đăng"] || 0);
  log(`\n▶ [STT ${val(f["STT"])}] "${title}" (Drive ${driveId})`);
  if (DRY) { log("  [dry-run] bỏ qua."); continue; }
  const tmp = path.join(os.tmpdir(), `yt-${driveId}.mp4`);
  try {
    await updateRow(row.id, { "Trạng thái": "Đang đăng" });

    // 1) tải từ Drive
    const gtok = await oauthToken("GOOGLE_OAUTH");
    const meta = await (await fetch(`https://www.googleapis.com/drive/v3/files/${driveId}?fields=size,name&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${gtok}` } })).json();
    const size = Number(meta.size);
    log(`  ↓ tải Drive: ${meta.name} (${(size / 1048576).toFixed(0)}MB)`);
    const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${driveId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${gtok}` } });
    if (!dl.ok) throw new Error(`Drive download HTTP ${dl.status}`);
    await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(tmp));

    // 2) resumable upload YouTube
    const ytok = await oauthToken("YT_OAUTH");
    const status = { privacyStatus: "public", selfDeclaredMadeForKids: false };
    // Đánh giá LẠI ngay trước khi tạo video: chỉ hẹn giờ nếu mốc còn cách >2 phút (tránh publishAt quá khứ
    // do tải/upload lâu -> YouTube từ chối). Nếu đã qua giờ hẹn thì công khai luôn.
    if (schedMs && schedMs > Date.now() + 120000) { status.privacyStatus = "private"; status.publishAt = new Date(schedMs).toISOString(); }
    const snippet = { title: title.slice(0, 100), description: val(f["Mô tả"]), tags: val(f["Tags"]).split(",").map((s) => s.trim()).filter(Boolean), categoryId: CATEGORY };
    log(`  ↑ upload YouTube (${status.publishAt ? "hẹn " + status.publishAt : "công khai ngay"})...`);
    const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: { Authorization: `Bearer ${ytok}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": "video/*" },
      body: JSON.stringify({ snippet, status }),
    });
    if (!init.ok) throw new Error(`YouTube init ${init.status}: ${(await init.text()).slice(0, 300)}`);
    const uploadUrl = init.headers.get("location");
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Length": String(size), "Content-Type": "video/*" }, body: fs.createReadStream(tmp), duplex: "half" });
    const putJson = await put.json();
    if (!put.ok || !putJson.id) throw new Error(`YouTube upload ${put.status}: ${JSON.stringify(putJson).slice(0, 300)}`);
    const videoId = putJson.id;
    const link = `https://youtu.be/${videoId}`;
    log(`  ✔ videoId=${videoId}`);

    // 3) thumbnail từ cover
    let thumbNote = "";
    if (coverId) {
      try {
        const cimg = await fetch(`https://www.googleapis.com/drive/v3/files/${coverId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${gtok}` } });
        const cbuf = Buffer.from(await cimg.arrayBuffer());
        const ts = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, { method: "POST", headers: { Authorization: `Bearer ${ytok}`, "Content-Type": "image/jpeg" }, body: cbuf });
        thumbNote = ts.ok ? " +thumbnail" : ` (thumbnail lỗi: ${ts.status} — kênh có thể chưa xác minh)`;
      } catch (e) { thumbNote = ` (thumbnail lỗi: ${e.message})`; }
      log(`  thumbnail:${thumbNote || " OK"}`);
    }

    // 4) ghi kết quả
    await updateRow(row.id, { "Trạng thái": "Đã đăng", "Video ID": videoId, "Link video": { link, text: title }, "Ngày đăng": now, "Ghi chú lỗi": "" });
    log(`  ✔ Đã đăng: ${link}${thumbNote}`);
  } catch (e) {
    log(`  ✗ Lỗi: ${e.message}`);
    try { await updateRow(row.id, { "Trạng thái": "Lỗi", "Ghi chú lỗi": String(e.message).slice(0, 900) }); } catch {}
  } finally {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {}
  }
}
log("\n✔ Hoàn tất lượt đăng.");
