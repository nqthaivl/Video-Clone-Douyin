# Video Clone Studio - Ứng dụng dịch thuật & Lồng tiếng AI

**Video Clone Studio** là ứng dụng desktop hỗ trợ tự động tách âm, dịch thuật, chuyển đổi giọng nói (Voice Cloning) và lồng tiếng cho video bằng trí tuệ nhân tạo (AI). Ứng dụng chạy hoàn toàn offline (cục bộ) trên thiết bị của bạn, bảo vệ dữ liệu tuyệt đối và không giới hạn số lượng xử lý.

---

## 🌟 Tính năng chính

- **🎙️ Voice Cloning (Clone giọng nói):** Trích xuất mẫu giọng từ 3-15 giây để tạo hồ sơ giọng nói AI mới, tự động bắt chước âm điệu của người nói gốc.
- **🎬 Video Dubbing (Dịch & Lồng tiếng):**
  - Tách nhạc nền và lời thoại bằng công cụ Demucs (Meta).
  - Nhận diện lời thoại (ASR) với độ chính xác cao bằng các mô hình WhisperX, Faster-Whisper.
  - Dịch tự động sang ngôn ngữ đích (hỗ trợ Google Translate, Argos Offline, NLLB-200 Local, LLM...).
  - Tạo giọng lồng tiếng AI mới khớp hoàn toàn timeline nhờ thuật toán Smart Fit.
  - Ghép và xuất tệp video MP4 (kèm nhạc nền gốc) hoặc audio WAV/phụ đề SRT.
- **👥 Speaker Diarization:** Tự động phát hiện và phân đoạn người nói (ai nói phân đoạn nào) để gán giọng lồng tiếng chính xác.

---

## 🔒 Hệ thống Bản quyền & Kích hoạt Bảo mật (Mới)

Ứng dụng tích hợp hệ thống bản quyền cục bộ gắn liền với phần cứng thiết bị nhằm chống sao chép và phân phối trái phép:

1. **Gắn liền phần cứng (Machine ID):** Mỗi máy tính sẽ sinh ra một **Mã máy tính (Machine ID)** duy nhất định dạng `XXXX-XXXX-XXXX` dựa trên địa chỉ MAC và cấu hình thiết bị.
2. **Xác thực bảo mật bằng Bytecode:** Logic xác thực bản quyền được cài đặt ở tầng Electron Javascript Main Process và được biên dịch sang **V8 Bytecode nhị phân (`.jsc`)** thông qua Bytenode trong các bản phát hành, giúp ngăn chặn hoàn toàn việc dịch ngược hoặc đọc trộm mã nguồn.
3. **Mã hóa liên kết Backend:** Electron giao tiếp với Python FastAPI backend qua cơ chế Session Token bảo mật được tạo ngẫu nhiên ở mỗi lần khởi chạy.

---

## 🛠️ Hướng dẫn Cài đặt & Phát triển

### Yêu cầu hệ thống
- **Node.js:** Phiên bản 18 hoặc 20+
- **Python:** Phiên bản 3.10 hoặc 3.11
- **Hardware:** Tối thiểu 8 GB RAM (Khuyên dùng GPU NVIDIA RTX với VRAM từ 6 GB trở lên để chạy AI mượt mà).

### Khởi chạy môi trường phát triển (Development)

1. Cài đặt các gói phụ thuộc NodeJS:
   ```bash
   npm install
   ```
2. Cài đặt môi trường ảo Python (venv) trong thư mục `backend/` và cài đặt các thư viện cần thiết (theo file `pyproject.toml`).
3. Chạy ứng dụng ở chế độ nhà phát triển:
   ```bash
   npm run dev
   ```

### Đóng gói ứng dụng (Production - Tạo thư mục giải nén)

Nhằm build ứng dụng thành thư mục thực thi chạy trực tiếp (`win-unpacked`), chạy lệnh:
```bash
npm run package:dir
```
Thư mục chạy trực tiếp sẽ được xuất tại `release/win-unpacked/Video Clone.exe`.

---

## 🔑 Hướng dẫn Tạo khóa & Kích hoạt Bản quyền

### Bước 1: Lấy Mã máy tính (Machine ID)
Khởi chạy ứng dụng **Video Clone**. Ở màn hình khởi động đầu tiên, ứng dụng sẽ hiển thị thông báo bản quyền kèm theo mã máy của bạn, ví dụ:
```
Mã máy tính (Machine ID): LBNX-4UXH-QXZ2
```
Nhấn nút **Sao chép** để copy mã máy này.

### Bước 2: Tạo mã kích hoạt (Activation Key)
Bạn sử dụng công cụ [keygen.py](keygen.py) được cung cấp sẵn trong dự án:

- **Cách 1: Sử dụng giao diện người dùng (GUI):**
  Kích đúp vào file `keygen.py` (hoặc chạy lệnh `python keygen.py` trong Terminal không có tham số). Cửa sổ giao diện đồ họa sẽ xuất hiện:
  1. Dán **Mã máy tính** đã sao chép ở Bước 1 vào ô nhập liệu.
  2. Bấm nút **TẠO MÃ KÍCH HOẠT**.
  3. Bấm nút **SAO CHÉP** để nhận Khóa bản quyền tương ứng (dạng `XXXX-XXXX-XXXX-XXXX`).

- **Cách 2: Sử dụng dòng lệnh (CLI):**
  Chạy lệnh trong CMD/Terminal kèm tham số là mã máy:
  ```bash
  python keygen.py LBNX-4UXH-QXZ2
  ```

### Bước 3: Kích hoạt ứng dụng
Quay lại giao diện ứng dụng **Video Clone**, dán khóa bản quyền vừa tạo vào ô nhập liệu và nhấn **Kích hoạt phần mềm**. 
Phần mềm sẽ tự động xác thực và mở khóa vĩnh viễn trên thiết bị đó.

---

## 📦 Kiến trúc Dự án

```
├── electron/
│   ├── main/
│   │   ├── index.ts            # Tầng xử lý chính của Electron & các IPC handlers
│   │   ├── backend-process.ts  # Spawn tiến trình Python backend và truyền biến môi trường bản quyền
│   │   └── license-verify.ts   # Logic sinh Machine ID và xác thực chữ ký bản quyền bằng JS
│   └── preload/
│       └── index.cts           # Cầu nối an toàn đưa getMachineId và activateLicense lên Frontend
├── src/
│   ├── App.tsx                 # Giao diện người dùng (React) & luồng hiển thị hộp thoại bản quyền
│   └── lib/api.ts              # API client giao tiếp với backend FastAPI
├── backend/
│   ├── main.py                 # API server FastAPI & Middleware lọc chặn yêu cầu khi chưa kích hoạt
│   └── core/
│       ├── license.py          # Đồng bộ trạng thái kích hoạt cục bộ từ biến môi trường và lưu key
│       └── prefs.py            # Lưu trữ và đọc ghi cấu hình người dùng (prefs.json)
└── keygen.py                   # Bộ tạo khóa kích hoạt bản quyền (hỗ trợ cả GUI và CLI)
```

---

## 📝 Giấy phép

Ứng dụng phát triển cho mục đích sử dụng cá nhân và thương mại. Mọi hành vi sửa đổi phân phối lại mã nguồn xác thực hoặc phần mềm cần tuân thủ các điều khoản bản quyền đi kèm.
