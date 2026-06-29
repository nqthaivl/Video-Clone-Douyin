# Video Clone Colab Runtime

Để tránh đưa toàn bộ code desktop lên Google Colab, app sẽ dùng repo runtime riêng:

```text
https://github.com/nqthaivl/videocolab.git
```

Notebook `Video_Clone_Douyin_Colab.ipynb` đã trỏ mặc định sang repo này.

## Cập nhật repo videocolab

Từ thư mục dự án chính, chạy:

```powershell
.\scripts\export-colab-runtime.ps1 -Destination "C:\Users\ezycloudx-admin\Downloads\videocolab" -Clean
```

Script chỉ xuất các phần cần để chạy backend trên Colab:

- `backend/`
- `omnivoice/`
- `pyproject.toml`
- `alembic.ini`
- `Video_Clone_Douyin_Colab.ipynb`
- `LICENSE`

Không xuất `src/`, `electron/`, `build/`, `dist/`, `keygen.py`, `package.json`, hoặc các file desktop khác.
