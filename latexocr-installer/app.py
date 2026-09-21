from __future__ import annotations

import ctypes
import os
import queue
import sys
import threading
import traceback
from dataclasses import dataclass
from pathlib import Path
from tkinter import Tk, Toplevel, Canvas, Frame, Label, Button, Text, StringVar, BooleanVar, Radiobutton, Checkbutton, filedialog, messagebox
from tkinter import ttk

import requests
from PIL import Image, ImageGrab, ImageTk

APP_NAME = "LaTeX OCR"
APP_VERSION = "1.0.2"
WEIGHTS_URL = "https://github.com/lukas-blecher/LaTeX-OCR/releases/download/v0.0.1/weights.pth"
RESIZER_URL = "https://github.com/lukas-blecher/LaTeX-OCR/releases/download/v0.0.1/image_resizer.pth"
WEIGHTS_SIZE = 102_113_875
RESIZER_SIZE = 19_441_973


def app_data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    p = Path(base) / "LaTeX-OCR"
    p.mkdir(parents=True, exist_ok=True)
    return p


MODEL_DIR = app_data_dir() / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
WEIGHTS_PATH = MODEL_DIR / "weights.pth"
RESIZER_PATH = MODEL_DIR / "image_resizer.pth"


def enable_windows_dpi_awareness() -> None:
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass


def set_clipboard_text(root: Tk, value: str) -> None:
    root.clipboard_clear()
    root.clipboard_append(value)
    root.update_idletasks()


@dataclass
class DownloadItem:
    url: str
    path: Path
    expected_size: int


def valid_file(path: Path, expected_size: int) -> bool:
    try:
        return path.is_file() and path.stat().st_size == expected_size
    except OSError:
        return False


class ModelManager:
    def __init__(self, event_queue: queue.Queue):
        self.q = event_queue
        self.items = [
            DownloadItem(WEIGHTS_URL, WEIGHTS_PATH, WEIGHTS_SIZE),
            DownloadItem(RESIZER_URL, RESIZER_PATH, RESIZER_SIZE),
        ]

    def ensure(self) -> None:
        missing = [x for x in self.items if not valid_file(x.path, x.expected_size)]
        if not missing:
            self.q.put(("download_done", None))
            return
        total = sum(x.expected_size for x in missing)
        done = 0
        for item in missing:
            tmp = item.path.with_suffix(item.path.suffix + ".part")
            try:
                if tmp.exists():
                    tmp.unlink()
                with requests.get(item.url, stream=True, timeout=(15, 60), allow_redirects=True) as r:
                    r.raise_for_status()
                    with open(tmp, "wb") as f:
                        for chunk in r.iter_content(chunk_size=1024 * 1024):
                            if not chunk:
                                continue
                            f.write(chunk)
                            done += len(chunk)
                            self.q.put(("download_progress", (done, total, item.path.name)))
                if tmp.stat().st_size != item.expected_size:
                    raise RuntimeError(f"{item.path.name} 下载大小校验失败")
                os.replace(tmp, item.path)
            except Exception:
                try:
                    tmp.unlink(missing_ok=True)
                except Exception:
                    pass
                raise
        self.q.put(("download_done", None))


class SnipOverlay:
    def __init__(self, app: "LatexOcrApp"):
        self.app = app
        self.root = Toplevel(app.root)
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg="black")

        if sys.platform == "win32":
            u32 = ctypes.windll.user32
            self.vx = u32.GetSystemMetrics(76)
            self.vy = u32.GetSystemMetrics(77)
            self.vw = u32.GetSystemMetrics(78)
            self.vh = u32.GetSystemMetrics(79)
        else:
            self.vx, self.vy = 0, 0
            self.vw, self.vh = app.root.winfo_screenwidth(), app.root.winfo_screenheight()

        app.root.withdraw()
        app.root.update_idletasks()
        try:
            self.screen = ImageGrab.grab(all_screens=True)
        except TypeError:
            self.screen = ImageGrab.grab()

        self.photo = ImageTk.PhotoImage(self.screen)
        self.canvas = Canvas(self.root, width=self.vw, height=self.vh, highlightthickness=0, cursor="cross")
        self.canvas.pack(fill="both", expand=True)
        self.canvas.create_image(0, 0, image=self.photo, anchor="nw")

        # Screenshot selection UX:
        # dim everything outside the selection, keep the selected area at full
        # brightness, and draw a double high-contrast border that stays visible
        # on both white documents and dark backgrounds.
        self.mask_ids = [
            self.canvas.create_rectangle(0, 0, 0, 0, fill="black", outline="", stipple="gray50")
            for _ in range(4)
        ]
        self.full_mask = self.canvas.create_rectangle(
            0, 0, self.vw, self.vh, fill="black", outline="", stipple="gray50"
        )
        self.outer_rect = self.canvas.create_rectangle(0, 0, 0, 0, outline="black", width=5)
        self.inner_rect = self.canvas.create_rectangle(0, 0, 0, 0, outline="#00E5FF", width=2)
        self.help_text = self.canvas.create_text(
            24, 22,
            text="拖动选择公式区域 · Esc 取消",
            anchor="nw",
            fill="white",
            font=("Segoe UI", 16, "bold"),
        )
        self.start_x = self.start_y = 0
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.root.bind("<Escape>", lambda e: self.cancel())
        self.root.geometry(f"{self.vw}x{self.vh}{self.vx:+d}{self.vy:+d}")
        self.root.deiconify()
        self.root.focus_force()

    def _update_selection_visual(self, x, y):
        x = max(0, min(self.vw, x))
        y = max(0, min(self.vh, y))
        x1, x2 = sorted((self.start_x, x))
        y1, y2 = sorted((self.start_y, y))

        # Four masks cover only the area outside the live selection.
        self.canvas.coords(self.mask_ids[0], 0, 0, self.vw, y1)
        self.canvas.coords(self.mask_ids[1], 0, y2, self.vw, self.vh)
        self.canvas.coords(self.mask_ids[2], 0, y1, x1, y2)
        self.canvas.coords(self.mask_ids[3], x2, y1, self.vw, y2)

        self.canvas.coords(self.outer_rect, x1, y1, x2, y2)
        self.canvas.coords(self.inner_rect, x1, y1, x2, y2)
        self.canvas.tag_raise(self.outer_rect)
        self.canvas.tag_raise(self.inner_rect)
        self.canvas.tag_raise(self.help_text)

    def on_press(self, event):
        self.start_x = max(0, min(self.vw, event.x))
        self.start_y = max(0, min(self.vh, event.y))
        if self.full_mask is not None:
            self.canvas.delete(self.full_mask)
            self.full_mask = None
        self._update_selection_visual(event.x, event.y)

    def on_drag(self, event):
        self._update_selection_visual(event.x, event.y)

    def on_release(self, event):
        x1, x2 = sorted((self.start_x, event.x))
        y1, y2 = sorted((self.start_y, event.y))
        if x2 - x1 < 8 or y2 - y1 < 8:
            self.cancel()
            return
        img = self.screen.crop((x1, y1, x2, y2))
        self.root.destroy()
        self.app.root.deiconify()
        self.app.root.lift()
        self.app.set_image(img)
        self.app.recognize()

    def cancel(self):
        self.root.destroy()
        self.app.root.deiconify()
        self.app.root.lift()


class LatexOcrApp:
    def __init__(self, start_worker: bool = True):
        enable_windows_dpi_awareness()
        self.root = Tk()
        self.root.title(f"{APP_NAME} {APP_VERSION}")
        self.root.geometry("780x600")
        self.root.minsize(680, 520)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self.q: queue.Queue = queue.Queue()
        self.model_manager = ModelManager(self.q)
        self.model = None
        self.model_error = None
        self.current_image: Image.Image | None = None
        self.preview_photo = None
        self.raw_result = ""
        self.worker_busy = False
        self.format_var = StringVar(value="latex")
        self.auto_copy = BooleanVar(value=True)
        self.status_var = StringVar(value="正在准备…")

        self.build_ui()
        self.root.after(80, self.poll_queue)
        if start_worker:
            threading.Thread(target=self.prepare_model, daemon=True).start()

    def build_ui(self):
        style = ttk.Style(self.root)
        try:
            style.theme_use("vista")
        except Exception:
            pass

        top = Frame(self.root, padx=18, pady=16)
        top.pack(fill="x")
        Label(top, text="LaTeX OCR", font=("Segoe UI", 20, "bold")).pack(side="left")
        Label(top, text="截图 / 粘贴 / 打开图片 → LaTeX", font=("Segoe UI", 10), fg="#555").pack(side="left", padx=(12, 0), pady=(8, 0))

        actions = Frame(self.root, padx=18)
        actions.pack(fill="x")
        self.snip_btn = Button(actions, text="截图识别  Alt+S", command=self.snip, font=("Segoe UI", 11, "bold"), padx=18, pady=8, state="disabled")
        self.snip_btn.pack(side="left")
        Button(actions, text="粘贴图片  Ctrl+V", command=self.paste_image, padx=14, pady=8).pack(side="left", padx=8)
        Button(actions, text="打开图片", command=self.open_image, padx=14, pady=8).pack(side="left")
        self.retry_btn = Button(actions, text="重新识别", command=self.recognize, padx=14, pady=8, state="disabled")
        self.retry_btn.pack(side="left", padx=8)

        content = Frame(self.root, padx=18, pady=14)
        content.pack(fill="both", expand=True)

        left = Frame(content, bd=1, relief="solid")
        left.pack(side="left", fill="both", expand=True, padx=(0, 10))
        Label(left, text="原图", font=("Segoe UI", 10, "bold"), anchor="w", padx=10, pady=8).pack(fill="x")
        self.preview = Label(left, text="截图、粘贴或打开一张公式图片", fg="#666", bg="white", anchor="center")
        self.preview.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        right = Frame(content, bd=1, relief="solid")
        right.pack(side="left", fill="both", expand=True, padx=(10, 0))
        Label(right, text="识别结果", font=("Segoe UI", 10, "bold"), anchor="w", padx=10, pady=8).pack(fill="x")
        self.output = Text(right, wrap="word", font=("Consolas", 11), undo=True, padx=10, pady=10)
        self.output.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        opts = Frame(self.root, padx=18, pady=0)
        opts.pack(fill="x", pady=(0, 6))
        Label(opts, text="格式：").pack(side="left")
        for label, value in [("LaTeX", "latex"), ("Raw", "raw"), ("Display $$", "display")]:
            Radiobutton(opts, text=label, variable=self.format_var, value=value, command=self.refresh_output).pack(side="left", padx=(0, 8))
        Checkbutton(opts, text="识别后自动复制", variable=self.auto_copy).pack(side="left", padx=(10, 0))
        Button(opts, text="复制结果", command=self.copy_result, padx=12).pack(side="right")

        status = Frame(self.root, padx=18, pady=0)
        status.pack(fill="x", pady=(4, 14))
        self.progress = ttk.Progressbar(status, orient="horizontal", mode="determinate", maximum=100)
        self.progress.pack(fill="x")
        Label(status, textvariable=self.status_var, anchor="w", fg="#555", pady=4).pack(fill="x")

        self.root.bind("<Alt-s>", lambda e: self.snip())
        self.root.bind("<Control-v>", lambda e: self.paste_image())

    def prepare_model(self):
        try:
            self.q.put(("status", "首次使用会自动下载约 120 MB OCR 模型；之后可离线运行。"))
            self.model_manager.ensure()
            self.q.put(("status", "正在加载 OCR 模型…"))
            import torch
            import pix2tex
            from argparse import Namespace
            from pix2tex.cli import LatexOCR

            config = Path(pix2tex.__file__).resolve().parent / "model" / "settings" / "config.yaml"
            args = Namespace(
                temperature=0.333,
                config=str(config),
                checkpoint=str(WEIGHTS_PATH),
                no_cuda=True,
                no_resize=False,
                show=False,
                katex=False,
                gui=True,
                file=[],
            )
            model = LatexOCR(args)
            self.q.put(("model_ready", model))
        except Exception as e:
            self.q.put(("model_error", (str(e), traceback.format_exc())))

    def poll_queue(self):
        try:
            while True:
                event, payload = self.q.get_nowait()
                if event == "download_progress":
                    done, total, name = payload
                    pct = max(0, min(100, done * 100 / max(total, 1)))
                    self.progress["value"] = pct
                    self.status_var.set(f"首次准备：正在下载 {name}… {pct:.0f}%")
                elif event == "download_done":
                    self.progress["value"] = 100
                elif event == "status":
                    self.status_var.set(payload)
                elif event == "model_ready":
                    self.model = payload
                    self.progress["value"] = 100
                    self.status_var.set("准备完成。点击“截图识别”，或 Ctrl+V 粘贴公式图片。")
                    self.snip_btn.config(state="normal")
                    if self.current_image is not None:
                        self.retry_btn.config(state="normal")
                elif event == "model_error":
                    msg, details = payload
                    self.model_error = details
                    self.status_var.set("模型初始化失败。")
                    messagebox.showerror(APP_NAME, f"模型初始化失败：\n{msg}\n\n可重新启动程序重试。")
                elif event == "recognition_done":
                    self.worker_busy = False
                    self.raw_result = payload
                    self.refresh_output()
                    self.status_var.set("识别完成。")
                    self.snip_btn.config(state="normal" if self.model else "disabled")
                    self.retry_btn.config(state="normal")
                elif event == "recognition_error":
                    self.worker_busy = False
                    self.status_var.set("识别失败。")
                    self.snip_btn.config(state="normal" if self.model else "disabled")
                    self.retry_btn.config(state="normal" if self.current_image else "disabled")
                    messagebox.showerror(APP_NAME, f"识别失败：\n{payload}")
        except queue.Empty:
            pass
        self.root.after(80, self.poll_queue)

    def format_result(self) -> str:
        s = self.raw_result.strip()
        if not s:
            return ""
        mode = self.format_var.get()
        if mode == "raw":
            return s
        if mode == "display":
            return "$$" + s + "$$"
        return "$" + s + "$"

    def refresh_output(self):
        value = self.format_result()
        self.output.delete("1.0", "end")
        self.output.insert("1.0", value)
        if value and self.auto_copy.get():
            set_clipboard_text(self.root, value)

    def copy_result(self):
        value = self.output.get("1.0", "end-1c")
        if not value:
            return
        set_clipboard_text(self.root, value)
        self.status_var.set("已复制到剪贴板。")

    def set_image(self, img: Image.Image):
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        self.current_image = img.copy()
        p = img.copy()
        p.thumbnail((330, 330), Image.Resampling.LANCZOS)
        self.preview_photo = ImageTk.PhotoImage(p)
        self.preview.configure(image=self.preview_photo, text="", bg="white")
        self.retry_btn.config(state="normal" if self.model else "disabled")

    def open_image(self):
        path = filedialog.askopenfilename(title="选择公式图片", filetypes=[("图片", "*.png;*.jpg;*.jpeg;*.bmp;*.webp"), ("所有文件", "*.*")])
        if not path:
            return
        try:
            with Image.open(path) as im:
                self.set_image(im.copy())
            self.recognize()
        except Exception as e:
            messagebox.showerror(APP_NAME, f"无法打开图片：\n{e}")

    def paste_image(self):
        try:
            data = ImageGrab.grabclipboard()
            if isinstance(data, Image.Image):
                self.set_image(data)
                self.recognize()
                return
            if isinstance(data, list) and data:
                with Image.open(data[0]) as im:
                    self.set_image(im.copy())
                self.recognize()
                return
            self.status_var.set("剪贴板里没有图片。")
        except Exception as e:
            messagebox.showerror(APP_NAME, f"读取剪贴板失败：\n{e}")

    def snip(self):
        if not self.model or self.worker_busy:
            return
        SnipOverlay(self)

    def recognize(self):
        if self.worker_busy or self.current_image is None:
            return
        if self.model is None:
            self.status_var.set("OCR 模型仍在加载，请稍候。")
            return
        self.worker_busy = True
        self.status_var.set("正在识别…")
        self.snip_btn.config(state="disabled")
        self.retry_btn.config(state="disabled")
        img = self.current_image.copy()

        def work():
            try:
                result = self.model(img)
                self.q.put(("recognition_done", result))
            except Exception as e:
                self.q.put(("recognition_error", str(e)))

        threading.Thread(target=work, daemon=True).start()

    def close(self):
        self.root.destroy()

    def run(self):
        self.root.mainloop()


def self_test() -> int:
    try:
        import torch
        import pix2tex
        from pix2tex.cli import LatexOCR
        config = Path(pix2tex.__file__).resolve().parent / "model" / "settings" / "config.yaml"
        if not config.is_file():
            return 2
        if not hasattr(torch, "__version__") or LatexOCR is None:
            return 3

        # Real UI smoke test: create the complete main window without starting
        # model download/loading, then destroy it. This catches invalid Tk
        # geometry/padding/options that import-only checks cannot detect.
        app = LatexOcrApp(start_worker=False)
        app.root.withdraw()
        app.root.update_idletasks()
        app.root.destroy()
        return 0
    except Exception:
        return 4


def main():
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    LatexOcrApp().run()


if __name__ == "__main__":
    main()
