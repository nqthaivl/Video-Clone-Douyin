import hashlib
import getpass
import os
import platform
import re
import socket
import subprocess
import sys
import tkinter as tk
from tkinter import messagebox

SECRET_SALT = "video_clone_secret_salt_2026"
_MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
_MACHINE_ID_RE = re.compile(r"^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$")
_APP_MACHINE_ID_PATH = os.path.join(
    os.environ.get("APPDATA", ""), "VideoCloneDouyin", "data", "machine.id"
)


def _normalize_mac(raw: str) -> str | None:
    mac = raw.strip().upper().replace("-", ":")
    if mac and mac != "00:00:00:00:00:00" and _MAC_RE.match(mac):
        return mac
    return None


def _collect_macs_getmac() -> list[str]:
    macs: list[str] = []
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        out = subprocess.check_output(
            ["getmac", "/fo", "csv", "/nh"],
            text=True,
            errors="replace",
            creationflags=flags,
        )
        for line in out.splitlines():
            if not line.strip():
                continue
            mac = _normalize_mac(line.split(",")[0].strip().strip('"'))
            if mac:
                macs.append(mac)
    except Exception:
        pass
    return macs


def collect_macs() -> list[str]:
    """Same rules as electron/main/license-verify.ts collectMacs()."""
    found: set[str] = set()
    try:
        import psutil

        for name in sorted(psutil.net_if_addrs().keys()):
            lowered = name.lower()
            if lowered in ("lo",) or lowered.startswith("loopback pseudo-interface"):
                continue
            for addr in psutil.net_if_addrs()[name]:
                if addr.family != psutil.AF_LINK:
                    continue
                mac = _normalize_mac(addr.address)
                if mac:
                    found.add(mac)
    except Exception:
        pass

    if sys.platform == "win32":
        found.update(_collect_macs_getmac())

    return sorted(found)


def compute_machine_id() -> str:
    """Match Electron computeMachineIdFromHardware() / backend license.py."""
    macs = collect_macs()
    if macs:
        seed = "".join(macs)
    else:
        seed = socket.gethostname() + getpass.getuser() + sys.platform + platform.machine()
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest().upper()
    return f"{digest[:4]}-{digest[4:8]}-{digest[8:12]}"


def read_app_machine_id() -> str | None:
    """Machine ID the app last wrote to %APPDATA%\\VideoCloneDouyin\\data\\machine.id."""
    try:
        with open(_APP_MACHINE_ID_PATH, encoding="utf-8") as f:
            first = f.readline().strip().upper()
        return first if _MACHINE_ID_RE.match(first) else None
    except OSError:
        return None


def normalize_machine_id(machine_id: str) -> str:
    cleaned = machine_id.replace("-", "").replace(" ", "").upper()
    if len(cleaned) != 12 or not re.fullmatch(r"[0-9A-F]{12}", cleaned):
        raise ValueError(
            "Mã máy tính (Machine ID) phải có dạng XXXX-XXXX-XXXX (12 ký tự hex)."
        )
    return f"{cleaned[:4]}-{cleaned[4:8]}-{cleaned[8:12]}"


def generate_key_for_machine(machine_id: str) -> str:
    normalized_machine = normalize_machine_id(machine_id).replace("-", "")
    hash_input = (normalized_machine + SECRET_SALT).encode("utf-8")
    full_key = hashlib.sha256(hash_input).hexdigest().upper()[:16]
    return f"{full_key[:4]}-{full_key[4:8]}-{full_key[8:12]}-{full_key[12:]}"


def verify_key_for_machine(machine_id: str, activation_key: str) -> bool:
    try:
        expected = generate_key_for_machine(machine_id)
    except ValueError:
        return False
    normalized = activation_key.replace("-", "").replace(" ", "").upper()
    return normalized == expected.replace("-", "")


def run_gui():
    root = tk.Tk()
    root.title("Trình tạo mã kích hoạt - Video Clone")
    root.geometry("560x360")
    root.resizable(False, False)
    root.configure(bg="#f5f7fb")

    font_title = ("Segoe UI", 13, "bold")
    font_label = ("Segoe UI", 9, "bold")
    font_hint = ("Segoe UI", 8)
    font_input = ("Consolas", 12, "bold")
    font_button = ("Segoe UI", 9, "bold")

    header_frame = tk.Frame(root, bg="#3f62dc", height=60)
    header_frame.pack(fill="x")
    tk.Label(
        header_frame,
        text="TRÌNH TẠO MÃ KÍCH HOẠT VIDEO CLONE",
        font=font_title,
        fg="white",
        bg="#3f62dc",
    ).pack(pady=15)

    body = tk.Frame(root, bg="#f5f7fb", padx=30, pady=12)
    body.pack(fill="both", expand=True)

    tk.Label(
        body,
        text="MÃ MÁY TÍNH (MACHINE ID):",
        font=font_label,
        fg="#5c6a85",
        bg="#f5f7fb",
    ).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 4))

    tk.Label(
        body,
        text="Copy chính xác từ app (Cài đặt → Kích hoạt). Không tự gõ.",
        font=font_hint,
        fg="#8a96ad",
        bg="#f5f7fb",
    ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 6))

    entry_machine = tk.Entry(
        body,
        font=font_input,
        fg="#27344e",
        bg="white",
        borderwidth=1,
        relief="solid",
        justify="center",
    )
    entry_machine.grid(row=2, column=0, columnspan=2, sticky="ew", ipady=6, pady=(0, 8))

    btn_row = tk.Frame(body, bg="#f5f7fb")
    btn_row.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(0, 10))
    btn_row.grid_columnconfigure(0, weight=1)
    btn_row.grid_columnconfigure(1, weight=1)

    def fill_local_id():
        local_id = compute_machine_id()
        app_id = read_app_machine_id()
        entry_machine.delete(0, tk.END)
        entry_machine.insert(0, app_id or local_id)
        if app_id and app_id != local_id:
            messagebox.showwarning(
                "Khác Machine ID",
                f"App đang lưu: {app_id}\nMáy tính này tính: {local_id}\n\n"
                "Ưu tiên dùng mã từ app. Nếu kích hoạt lỗi, copy lại từ app sau khi mở app.",
                parent=root,
            )

    tk.Button(
        btn_row,
        text="LẤY ID MÁY NÀY",
        font=font_button,
        bg="white",
        fg="#3f62dc",
        activebackground="#f0f4fd",
        borderwidth=1,
        relief="solid",
        cursor="hand2",
        command=fill_local_id,
    ).grid(row=0, column=0, sticky="ew", padx=(0, 6), ipady=4)

    btn_generate = tk.Button(
        btn_row,
        text="TẠO MÃ KÍCH HOẠT",
        font=font_button,
        bg="#3f62dc",
        fg="white",
        activebackground="#314eb0",
        activeforeground="white",
        borderwidth=0,
        cursor="hand2",
    )
    btn_generate.grid(row=0, column=1, sticky="ew", padx=(6, 0), ipady=4)

    tk.Label(
        body,
        text="MÃ KÍCH HOẠT (ACTIVATION KEY):",
        font=font_label,
        fg="#5c6a85",
        bg="#f5f7fb",
    ).grid(row=4, column=0, columnspan=2, sticky="w", pady=(0, 4))

    entry_key = tk.Entry(
        body,
        font=font_input,
        fg="#24967c",
        bg="#eefbf7",
        borderwidth=1,
        relief="solid",
        justify="center",
        state="readonly",
    )
    entry_key.grid(row=5, column=0, sticky="ew", ipady=6)

    btn_copy = tk.Button(
        body,
        text="SAO CHÉP",
        font=font_button,
        bg="white",
        fg="#3f62dc",
        activebackground="#f0f4fd",
        borderwidth=1,
        relief="solid",
        cursor="hand2",
    )
    btn_copy.grid(row=5, column=1, sticky="ew", padx=(12, 0), ipady=5)

    body.grid_columnconfigure(0, weight=4)
    body.grid_columnconfigure(1, weight=1)

    def on_generate():
        machine_id = entry_machine.get().strip()
        if not machine_id:
            messagebox.showwarning("Cảnh báo", "Vui lòng nhập Mã máy tính.", parent=root)
            return
        try:
            normalized = normalize_machine_id(machine_id)
            key = generate_key_for_machine(normalized)
            entry_machine.delete(0, tk.END)
            entry_machine.insert(0, normalized)
            entry_key.config(state="normal")
            entry_key.delete(0, tk.END)
            entry_key.insert(0, key)
            entry_key.config(state="readonly")
        except ValueError as e:
            messagebox.showerror("Lỗi", str(e), parent=root)

    def on_copy():
        key = entry_key.get().strip()
        if key:
            root.clipboard_clear()
            root.clipboard_append(key)
            messagebox.showinfo("Thành công", "Đã sao chép mã kích hoạt!", parent=root)
        else:
            messagebox.showwarning("Cảnh báo", "Vui lòng tạo mã kích hoạt trước.", parent=root)

    btn_generate.config(command=on_generate)
    btn_copy.config(command=on_copy)
    entry_machine.bind("<Return>", lambda _e: on_generate())

    root.mainloop()


def main():
    if len(sys.argv) >= 2:
        arg = sys.argv[1].strip()
        if arg in ("--local", "-l"):
            local_id = compute_machine_id()
            app_id = read_app_machine_id()
            print("=" * 55)
            print("MACHINE ID TRÊN MÁY NÀY")
            print("=" * 55)
            print(f"Tính từ phần cứng     : {local_id}")
            if app_id:
                print(f"App đang lưu (ưu tiên): {app_id}")
            print(f"MAC dùng để tính      : {', '.join(collect_macs()) or '(fallback hostname)'}")
            print("=" * 55)
            return

        machine_id = arg
        activation_key = None
        if len(sys.argv) >= 4 and sys.argv[2] == "--verify":
            activation_key = sys.argv[3]
        try:
            normalized = normalize_machine_id(machine_id)
            key = generate_key_for_machine(normalized)
            print("=" * 55)
            print("MÃ KÍCH HOẠT VIDEO CLONE")
            print("=" * 55)
            print(f"Mã máy tính (Machine ID) : {normalized}")
            print(f"Mã kích hoạt tương ứng   : {key}")
            if activation_key:
                ok = verify_key_for_machine(normalized, activation_key)
                print(f"Kiểm tra mã nhập vào     : {'HỢP LỆ' if ok else 'KHÔNG HỢP LỆ'}")
            print("=" * 55)
        except ValueError as e:
            print(f"Lỗi: {e}")
            sys.exit(1)
    else:
        run_gui()


if __name__ == "__main__":
    main()
