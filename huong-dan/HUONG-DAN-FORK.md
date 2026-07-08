# 🍴 Hướng dẫn dùng khi FORK repo này

Bạn vừa fork từ `hoangminhhoagpt-dot/mentor-club-youtube`. Code dùng chung, nhưng **token là của riêng bạn**.

> ⚠️ Quan trọng: khi fork, GitHub **KHÔNG sao chép** Secrets & Variables của chủ gốc. Bản fork của bạn ban đầu **trống secret** — bạn phải tự điền token của mình. (Đây là điều tốt: không ai lấy được token của người khác.)

---

## Bước 1 — Fork
Mở https://github.com/hoangminhhoagpt-dot/mentor-club-youtube → nút **Fork** → **Create fork**.
Bạn được repo `github.com/<tên-bạn>/mentor-club-youtube`.

## Bước 2 — Chuẩn bị giá trị của riêng bạn
Bạn cần bộ token/ID của **chính bạn** (xem bảng ở [CHECKLIST-CAI-DAT-YOUTUBE.md](CHECKLIST-CAI-DAT-YOUTUBE.md) PHẦN 0):
YouTube API key · Lark App ID/Secret · Lark Base ID + 3 table id · kênh YouTube · OAuth Client ID/Secret + refresh token · (tùy chọn) webhook Lark.

## Bước 3 — Chọn cách chạy

### Cách A — Chạy trên máy (local)
Theo [CHECKLIST-CAI-DAT-YOUTUBE.md](CHECKLIST-CAI-DAT-YOUTUBE.md): clone bản fork của bạn → tạo `config.local.json` → điền token của bạn → chạy. Không cần đụng GitHub Secrets.

### Cách B — Chạy trên cloud (GitHub Actions, gọi HTTP)
Trong **repo fork của bạn**: Settings → Secrets and variables → Actions, điền **Secrets + Variables của bạn** (danh sách ở [SETUP-GITHUB.md](SETUP-GITHUB.md)).
> Fork được tạo với Actions **tắt mặc định** — vào tab **Actions** của bản fork bấm **"I understand my workflows, go ahead and enable them"** để bật.

## Bước 4 — Gọi qua HTTP (nếu dùng Cách B)
Dùng repo **của bạn** trong URL (không phải repo gốc) + PAT **của bạn**:
```
POST https://api.github.com/repos/<tên-bạn>/mentor-club-youtube/dispatches
Authorization: Bearer <PAT-của-bạn>
Body: {"event_type":"sync-youtube","client_payload":{"channel":"@kênh-của-bạn"}}
```
Mẫu đầy đủ: [HTTP-Lark-templates.md](HTTP-Lark-templates.md) (nhớ đổi `hoangminhhoagpt-dot` → tên bạn).

---

## Tóm tắt
| Thứ | Chủ gốc | Bản fork của bạn |
|---|---|---|
| Code / workflow | ✅ có sẵn | ✅ copy tự động khi fork |
| Secrets / Variables | của chủ gốc | ❌ trống → **bạn tự điền** |
| Token gọi HTTP (PAT) | của chủ gốc | **PAT của bạn** |
| URL `/dispatches` | repo gốc | **repo của bạn** |
