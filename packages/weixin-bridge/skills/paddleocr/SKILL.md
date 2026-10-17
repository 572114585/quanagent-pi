---
name: paddleocr
description: 用 PaddleOCR-VL 对图片、PDF、Word/Excel/PPT 等文档做 OCR，提取为 markdown 文本。当需要识别或提取文件中的文字内容时使用（例如收到扫描件、截图、文档，需要知道里面写了什么）。
---

# PaddleOCR 识别

调用 PaddleOCR-VL-1.6 云服务识别文档/图片，输出 markdown。

## 用法

先在桥接进程的环境中设置 `PADDLEOCR_TOKEN`，脚本从该环境变量读取服务凭证。

脚本位于本 skill 目录下（与 SKILL.md 同目录）：

```
python "<本skill目录>/ocr.py" <文件或URL> --out <输出目录> [--no-images]
```

- `<文件或URL>`：本地文件绝对路径（如工作区 inbox/ 下收到的文件），或图片/文档的 http(s) URL。
- `--out`：markdown 与图片的输出目录，建议用当前工作目录下的子目录，例如 `./ocr_output`。
- `--no-images`：可选，只要文字不要图片时加上，速度更快。
- 识别一页约需几秒，多页文档可能需要一两分钟，命令会持续打印进度。

## 结果处理

- 成功后每页生成一个 `doc_<n>.md`，命令末尾会列出所有结果文件的绝对路径。
- 用 read 工具读取这些 markdown，再根据内容回答用户。
- 回复用户时遵守工作区的纯文本要求（不用 markdown 语法）。

## 注意

- 依赖 Python 3 与 requests 库；若提示缺少 requests，先执行 `pip install requests`。
- 不要把识别出的大段全文直接发给用户，先总结，用户要全文再给。
