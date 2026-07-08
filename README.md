# Module YouTube ↔ Lark Base

Bộ 2 skill Node (zero-dependency) chạy được cả **máy local** lẫn **GitHub Actions** (gọi qua HTTP từ Lark Base):

| Skill | Việc |
|---|---|
| [`hmh-AIOS-sync-youtube-lark`](.claude/skills/hmh-AIOS-sync-youtube-lark) | Kéo dữ liệu kênh + video YouTube → Lark Base (2 bảng), có pre-flight + card báo cáo |
| [`hmh-AIOS-dang-video-youtube`](.claude/skills/hmh-AIOS-dang-video-youtube) | Đăng video từ bảng Lark → YouTube (OAuth, resumable) |

## 📚 Hướng dẫn (đọc theo thứ tự)

| Bước | Tài liệu | Dùng khi |
|---|---|---|
| ⭐ 1 | [Checklist cài đặt (điền & chạy)](huong-dan/CHECKLIST-CAI-DAT-YOUTUBE.md) | Cài cho máy mới — copy lệnh dán là xong |
| 2 | [Hướng dẫn cài chi tiết](huong-dan/README-CAI-DAT.md) | Giải thích rõ local vs cloud |
| 3 | [Setup GitHub Actions](huong-dan/SETUP-GITHUB.md) | Điền Secrets/Variables để chạy cloud |
| 4 | [Mẫu gọi HTTP từ Lark](huong-dan/HTTP-Lark-templates.md) | Nối vào automation Lark Base |
| 5 | [Quy trình đăng video từ Lark](huong-dan/QUY-TRINH-dang-youtube-tu-lark.md) | Cách vận hành bảng đăng video |
| 🍴 | [Hướng dẫn khi FORK repo](huong-dan/HUONG-DAN-FORK.md) | Người khác fork về dùng cho kênh/base riêng |

## 🍴 Muốn dùng cho kênh/khách của bạn?
Bấm **Fork** ở góc trên repo này rồi làm theo [HUONG-DAN-FORK.md](huong-dan/HUONG-DAN-FORK.md) — điền token của riêng bạn (fork không sao chép Secrets của chủ gốc).

## Chạy nhanh (đã cài xong)
```powershell
# Kéo dữ liệu kênh
node ".claude\skills\hmh-AIOS-sync-youtube-lark\scripts\sync-youtube-lark.mjs" --only channel
# Đăng video (thử)
node ".claude\skills\hmh-AIOS-dang-video-youtube\scripts\post-video-youtube.mjs" --dry-run
```

## Gọi qua HTTP (cloud)
`POST https://api.github.com/repos/hoangminhhoagpt-dot/mentor-club-youtube/dispatches`
→ event `sync-youtube` hoặc `dang-video-youtube`. Chi tiết ở [HTTP-Lark-templates.md](huong-dan/HTTP-Lark-templates.md).

> 🔒 Không bao giờ commit `config.local.json` (đã chặn trong `.gitignore`).
