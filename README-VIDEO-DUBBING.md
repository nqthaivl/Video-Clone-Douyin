# Video Dubbing

Ứng dụng desktop độc lập dùng Electron + React + TypeScript, FastAPI và SQLite.

## Cài đặt

```powershell
.\setup.ps1
npm run dev
```

Model được lưu trong thư mục dữ liệu riêng của ứng dụng (`Video Dubbing/models`
trong Electron userData). Lần khởi động đầu tiên ứng dụng yêu cầu tải OmniVoice
TTS và Faster-Whisper; các lần sau dùng lại cache cục bộ.

FFmpeg phải có trong PATH. Pyannote diarization là tùy chọn và cần Hugging Face
token/license; không có token thì pipeline vẫn hoạt động với speaker fallback.
