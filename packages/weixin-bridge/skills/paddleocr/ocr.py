"""PaddleOCR-VL 文档/图片 OCR：提交任务 → 轮询结果 → 保存 markdown 与图片。

用法:
    python ocr.py <本地文件路径或 http(s) URL> [--out 输出目录]

默认输出目录为当前工作目录下的 ocr_output/。
"""
import argparse
import json
import os
import sys
import time

import requests

JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
TOKEN = os.environ.get("PADDLEOCR_TOKEN")
MODEL = "PaddleOCR-VL-1.6"
POLL_INTERVAL_S = 5
JOB_TIMEOUT_S = 600


def submit_job(file_path: str) -> str:
    headers = {"Authorization": f"bearer {TOKEN}"}
    optional_payload = {
        "useDocOrientationClassify": False,
        "useDocUnwarping": False,
        "useChartRecognition": False,
    }

    if file_path.startswith("http"):
        headers["Content-Type"] = "application/json"
        payload = {"fileUrl": file_path, "model": MODEL, "optionalPayload": optional_payload}
        resp = requests.post(JOB_URL, json=payload, headers=headers)
    else:
        if not os.path.exists(file_path):
            raise SystemExit(f"错误：文件不存在 {file_path}")
        data = {"model": MODEL, "optionalPayload": json.dumps(optional_payload)}
        with open(file_path, "rb") as f:
            resp = requests.post(JOB_URL, headers=headers, data=data, files={"file": f})

    if resp.status_code != 200:
        raise SystemExit(f"提交任务失败（HTTP {resp.status_code}）：{resp.text}")
    return resp.json()["data"]["jobId"]


def wait_for_job(job_id: str) -> str:
    """轮询直到任务完成，返回结果 jsonl 的下载地址。"""
    headers = {"Authorization": f"bearer {TOKEN}"}
    deadline = time.time() + JOB_TIMEOUT_S
    while True:
        resp = requests.get(f"{JOB_URL}/{job_id}", headers=headers)
        if resp.status_code != 200:
            raise SystemExit(f"查询任务失败（HTTP {resp.status_code}）：{resp.text}")
        data = resp.json()["data"]
        state = data["state"]
        if state == "done":
            progress = data.get("extractProgress", {})
            print(
                f"任务完成：提取 {progress.get('extractedPages', '?')} 页"
                f"（{progress.get('startTime', '?')} → {progress.get('endTime', '?')}）"
            )
            return data["resultUrl"]["jsonUrl"]
        if state == "failed":
            raise SystemExit(f"任务失败：{data.get('errorMsg', '未知原因')}")
        if time.time() > deadline:
            raise SystemExit(f"任务超时（{JOB_TIMEOUT_S}s），job_id={job_id}")
        print(f"任务状态：{state}，{POLL_INTERVAL_S}s 后重试…", flush=True)
        time.sleep(POLL_INTERVAL_S)


def save_results(jsonl_url: str, output_dir: str, save_images: bool) -> list[str]:
    """下载解析结果，保存 markdown 与图片，返回生成的 markdown 绝对路径列表。"""
    resp = requests.get(jsonl_url)
    resp.raise_for_status()

    os.makedirs(output_dir, exist_ok=True)
    md_paths: list[str] = []
    page_num = 0
    for line in resp.text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        result = json.loads(line)["result"]
        for res in result["layoutParsingResults"]:
            md_path = os.path.join(output_dir, f"doc_{page_num}.md")
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(res["markdown"]["text"])
            md_paths.append(os.path.abspath(md_path))
            print(f"已保存 markdown: {os.path.abspath(md_path)}")

            if save_images:
                for img_path, img_url in res["markdown"]["images"].items():
                    full_path = os.path.join(output_dir, img_path)
                    os.makedirs(os.path.dirname(full_path), exist_ok=True)
                    img_resp = requests.get(img_url)
                    if img_resp.status_code == 200:
                        with open(full_path, "wb") as f:
                            f.write(img_resp.content)
                        print(f"已保存图片: {os.path.abspath(full_path)}")

                for img_name, img_url in res.get("outputImages", {}).items():
                    img_resp = requests.get(img_url)
                    if img_resp.status_code == 200:
                        out_path = os.path.join(output_dir, f"{img_name}_{page_num}.jpg")
                        with open(out_path, "wb") as f:
                            f.write(img_resp.content)
                        print(f"已保存图片: {os.path.abspath(out_path)}")
            page_num += 1
    return md_paths


def main() -> None:
    parser = argparse.ArgumentParser(description="PaddleOCR-VL 识别")
    parser.add_argument("file", help="本地文件路径或 http(s) URL")
    parser.add_argument("--out", default="ocr_output", help="输出目录（默认 ./ocr_output）")
    parser.add_argument("--no-images", action="store_true", help="只保存 markdown，不下载图片")
    args = parser.parse_args()

    if not TOKEN:
        raise SystemExit("请设置 PADDLEOCR_TOKEN 环境变量")

    print(f"处理文件: {args.file}")
    job_id = submit_job(args.file)
    print(f"任务已提交，job_id: {job_id}")
    jsonl_url = wait_for_job(job_id)
    md_paths = save_results(jsonl_url, args.out, save_images=not args.no_images)
    if not md_paths:
        raise SystemExit("任务完成但未产生任何识别结果")
    print("识别完成，结果文件：")
    for p in md_paths:
        print(p)


if __name__ == "__main__":
    main()
