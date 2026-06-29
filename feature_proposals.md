# Đề xuất Nâng cấp Chức năng cho Video Clone Studio

Dựa trên việc phân tích mã nguồn hiện tại của dự án, chúng tôi phát hiện ra backend của hệ thống đã được xây dựng sẵn rất nhiều API mạnh mẽ và thú vị nhưng **chưa được khai thác hoặc hiển thị trên giao diện người dùng (React Frontend)**.

Dưới đây là các đề xuất nâng cấp tính năng đột phá, giúp tối ưu hóa tài nguyên sẵn có và nâng tầm trải nghiệm của Video Clone Studio thành một studio chuyên nghiệp toàn diện.

---

## 1. Studio Sách Nói Đa Giọng (Audiobook Creator Studio)
* **Tính năng hiện trạng (Backend):** File [audiobook.py](file:///c:/Users/ezycloudx-admin/Downloads/video-Dubbing-main/video-Dubbing-main/backend/api/routers/audiobook.py) đã hỗ trợ phân tích cú pháp kịch bản Markdown phân chia theo chương (`# H1`), chỉ định giọng nói cho từng phân đoạn dạng `[voice:Ten_Giong]` và các lệnh tạm dừng `[pause 2.5s]`. Backend cũng đã hỗ trợ ghép nối xuất file định dạng `.m4b` (định dạng audiobook tiêu chuẩn có phân chương) và chỉnh sửa thông tin sách (ACX Mastering).
* **Đề xuất nâng cấp giao diện:**
  * Thêm tab **"Studio Sách Nói"** trong giao diện chính.
  * Hỗ trợ tải lên file văn bản `.txt`, `.md` hoặc nhập trực tiếp kịch bản.
  * Tích hợp giao diện trực quan cho phép chọn giọng nói cho từng nhân vật trong truyện (ví dụ: Giọng người dẫn chuyện, Giọng nhân vật A, Giọng nhân vật B).
  * Hiển thị danh sách chương và tiến trình render từng chương theo thời gian thực.
  * Tải xuống trực tiếp file sách nói `.m4b` hoàn chỉnh có kèm bìa sách (Cover Image) và siêu dữ liệu (Metadata) tương thích với Apple Books, Google Play Books.

---

## 2. Thiết kế Giọng nói bằng Ngôn ngữ Tự nhiên (Natural Voice Designer)
* **Tính năng hiện trạng (Backend):** File [describe_voice.py](file:///c:/Users/ezycloudx-admin/Downloads/video-Dubbing-main/video-Dubbing-main/backend/api/routers/describe_voice.py) chứa logic phân tích mô tả giọng nói tự nhiên tự động sang các thuộc tính thiết kế giọng nói (Gender, Age, Pitch, Accent...) trên CPU ngay lập tức mà không cần mạng Internet.
* **Đề xuất nâng cấp giao diện:**
  * Tích hợp thanh tìm kiếm/thiết kế giọng nói bằng prompt vào tab **Cấu Hình** hoặc phần **Quản lý Giọng nói**.
  * Người dùng chỉ cần nhập mô tả bằng văn bản như: *"Giọng nam miền Nam trầm ấm, tốc độ vừa phải, phong cách tin tức"* hoặc *"Giọng nữ trẻ tuổi, nói nhanh, vui vẻ"*.
  * Hệ thống tự động phân tích và cấu hình các thanh trượt thông số AI để tạo ra một giọng nói (Persona) mới phù hợp nhất ngay lập tức để người dùng nghe thử và lưu lại.

---

## 3. Chợ Giọng nói Cục bộ & Chia sẻ (.omnivoice Marketplace)
* **Tính năng hiện trạng (Backend):** File [marketplace.py](file:///c:/Users/ezycloudx-admin/Downloads/video-Dubbing-main/video-Dubbing-main/backend/api/routers/marketplace.py) đã hỗ trợ việc nén và xuất các profile giọng nói tùy chỉnh thành gói `.omnivoice` (bao gồm tệp âm thanh mẫu, ảnh thumbnail, mô tả và cấu hình giọng nói) cũng như nhập gói này vào hệ thống database.
* **Đề xuất nâng cấp giao diện:**
  * Thêm tab **"Thư viện & Chợ Giọng nói"**.
  * Cho phép người dùng xuất (Export) giọng nói đã clone của mình ra một file `.omnivoice` để chia sẻ cho người khác chỉ bằng 1 click.
  * Hỗ trợ chức năng kéo thả file `.omnivoice` vào ứng dụng để nhập (Import) giọng nói mới mà không cần thực hiện clone lại từ đầu.
  * Xây dựng giao diện duyệt danh sách giọng nói mẫu (Voice Gallery) được phân loại theo danh mục, nhãn (tags), nhân vật để dễ dàng quản lý.

---

## 4. Trình Kiểm định deepfake & Watermark Âm thanh (Audio Authenticity Checker)
* **Tính năng hiện trạng (Backend):** File [watermark.py](file:///c:/Users/ezycloudx-admin/Downloads/video-Dubbing-main/video-Dubbing-main/backend/api/routers/watermark.py) tích hợp thư viện AudioSeal để chèn watermark ẩn vào âm thanh được sinh ra từ AI và hỗ trợ API phát hiện watermark từ tệp tải lên.
* **Đề xuất nâng cấp giao diện:**
  * Bổ sung tính năng **"Xác minh âm thanh"** trong phần cài đặt bảo mật.
  * Người dùng có thể kéo thả bất kỳ file âm thanh nào (`.mp3`, `.wav`) vào để kiểm tra xem file đó có phải được sinh ra từ phần mềm Video Clone Studio của mình hay không, tránh việc bị lạm dụng hoặc giả mạo giọng nói.
  * Hiển thị tỷ lệ phần trăm độ tin cậy và thông tin nguồn gốc nếu phát hiện thấy watermark ẩn.

---

## 5. Trình Biên tập Dòng thời gian Trực quan (Visual Waveform / Timeline Editor)
* **Đề xuất tính năng mới hoàn toàn:**
  * Hiện tại giao diện chỉnh sửa kịch bản lồng tiếng hiển thị dạng danh sách bảng (table/card). Việc điều chỉnh khớp thời lượng video (Smart Fit) được tính toán tự động.
  * **Nâng cấp đột phá:** Tích hợp một thanh timeline dạng sóng âm (waveform) nhỏ dưới chân màn hình hoặc tích hợp trực tiếp vào mỗi phân đoạn.
  * Cho phép người dùng nhìn thấy biểu đồ sóng âm của phân đoạn thoại gốc và phân đoạn thoại đã lồng tiếng để so sánh trực quan.
  * Đưa ra cảnh báo đỏ nếu văn bản dịch quá dài so với thời lượng gốc, cho phép kéo dài/thu ngắn tốc độ đọc (speed rate) hoặc dịch lại nhanh để khớp hoàn toàn một cách thủ công ngay trên dòng thời gian.

---

### Bạn muốn triển khai tính năng nào trước?
1. **[Lựa chọn 1]** Thêm tab **Studio Sách Nói (Audiobook Studio)** tích hợp đầy đủ tính năng tạo truyện/sách đa giọng nói và xuất file `.m4b`.
2. **[Lựa chọn 2]** Thiết lập giao diện **Quản lý & Chia sẻ Giọng nói (.omnivoice Marketplace)** giúp nhập/xuất và duyệt thư viện giọng nói trực quan hơn.
3. **[Lựa chọn 3]** Bổ sung công cụ **Thiết kế Giọng nói bằng Prompt (Natural Voice Designer)** vào phần tạo giọng nói mới.
4. **[Lựa chọn 4]** Tích hợp công cụ **Kiểm định deepfake / Watermark (Audio Authenticity Checker)**.

*Hãy phản hồi lựa chọn của bạn hoặc đóng góp thêm ý kiến để chúng tôi cùng bắt tay vào xây dựng nhé!*
