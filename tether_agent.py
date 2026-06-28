import os
import json
import shlex
import subprocess
import urllib.request
import glob
import uuid
from typing import Any, Dict, Optional, Tuple

import modal

DISCORD_COLOR_INFO = 16644256    # Yellow
DISCORD_COLOR_ERROR = 15158332   # Red
DISCORD_COLOR_SUCCESS = 7987918  # Mint/Teal

MAGNET_PREFIX = "magnet:?"

transcoder_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "aria2", "awscli")
    .pip_install("fastapi[standard]")
    .env({
        "AWS_DEFAULT_REGION": "auto",
        "AWS_REGION": "auto",
    })
)

app = modal.App("tether-agent")


def send_discord_notification(
    webhook_url: Optional[str],
    title: str,
    description: str,
    color: int = DISCORD_COLOR_INFO,
) -> None:
    if not webhook_url:
        return
    payload = {
        "embeds": [{
            "title": title,
            "description": description[:2000],
            "color": color,
        }]
    }
    req = urllib.request.Request(
        webhook_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        print(f"[Discord] Failed to send notification: {exc}")


def run_command(
    command: list[str],
    step_name: str,
    webhook_url: Optional[str],
) -> None:
    cmd_str = " ".join(shlex.quote(a) for a in command)
    print(f"\n[{step_name}] Starting: {cmd_str}")
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    output_lines: list[str] = []
    for line in process.stdout:  # type: ignore[union-attr]
        print(line, end="")
        output_lines.append(line)

    process.wait()

    if process.returncode != 0:
        tail = "".join(output_lines[-50:])
        send_discord_notification(
            webhook_url,
            title=f"Pipeline Failed: {step_name}",
            description="```\n" + tail + "\n```",
            color=DISCORD_COLOR_ERROR,
        )
        raise RuntimeError(f"Step '{step_name}' exited with code {process.returncode}")


def get_codecs(file_path: str) -> Tuple[Optional[str], Optional[str]]:
    def probe(stream_spec: str) -> str:
        return subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-select_streams", stream_spec,
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()

    try:
        return probe("v:0"), probe("a:0")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffprobe failed on '{file_path}': {exc}") from exc


def validate_magnet(magnet: str) -> None:
    if not magnet or not magnet.startswith(MAGNET_PREFIX):
        raise ValueError(
            f"Invalid magnet link — must start with '{MAGNET_PREFIX}'. Got: {magnet!r}"
        )


def cleanup(*paths: str) -> None:
    import shutil
    for path in paths:
        try:
            if os.path.isdir(path):
                shutil.rmtree(path)
            elif os.path.isfile(path):
                os.remove(path)
        except OSError as exc:
            print(f"[Cleanup] Warning: could not remove {path}: {exc}")


@app.function(
    image=transcoder_image,
    gpu="T4",
    timeout=14400,
    secrets=[modal.Secret.from_name("tether-agent")],
)
def process_movie(magnet_link: str) -> None:
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    r2_endpoint = os.environ.get("R2_ENDPOINT_URL")
    r2_bucket   = os.environ.get("R2_BUCKET", "movies")

    if not r2_endpoint:
        raise RuntimeError("R2_ENDPOINT_URL secret is not set.")

    file_uuid    = str(uuid.uuid4())
    download_dir = f"/tmp/torrent-{file_uuid}"
    final_output = f"/tmp/{file_uuid}.mp4"

    try:
        validate_magnet(magnet_link)

        send_discord_notification(
            webhook_url,
            "Pipeline Status: Download Started",
            "Initializing headless torrent download via Modal.",
        )
        run_command(
            [
                "aria2c",
                "--seed-time=0",
                "--summary-interval=5",
                "--max-overall-upload-limit=1K",
                f"--dir={download_dir}",
                magnet_link,
            ],
            "Torrent Download",
            webhook_url,
        )

        video_files = (
            glob.glob(f"{download_dir}/**/*.mkv", recursive=True)
            + glob.glob(f"{download_dir}/**/*.mp4", recursive=True)
            + glob.glob(f"{download_dir}/**/*.avi", recursive=True)
        )
        if not video_files:
            raise RuntimeError("No video files found after download.")
        temp_source = max(video_files, key=os.path.getsize)

        v_codec, a_codec = get_codecs(temp_source)

        if v_codec == "h264" and a_codec == "aac":
            send_discord_notification(
                webhook_url,
                "Pipeline Status: Processing",
                f"Codecs validated ({v_codec} / {a_codec}). Remuxing container directly.",
            )
            run_command(
                ["ffmpeg", "-hide_banner", "-y", "-i", temp_source, "-c", "copy", final_output],
                "Container Muxing",
                webhook_url,
            )
        else:
            send_discord_notification(
                webhook_url,
                "Pipeline Status: Transcoding",
                f"Unsupported codecs ({v_codec} / {a_codec}). Booting T4 hardware encoder.",
            )
            run_command(
                [
                    "ffmpeg", "-hide_banner", "-y",
                    "-hwaccel", "cuda",
                    "-i", temp_source,
                    "-map", "0:v:0", "-map", "0:a", "-map", "0:s?",
                    "-map_metadata", "0",
                    "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq",
                    "-b:v", "3M", "-maxrate", "3.5M", "-bufsize", "6M",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "320k",
                    "-c:s", "mov_text",
                    final_output,
                ],
                "Hardware Transcoding",
                webhook_url,
            )

        send_discord_notification(
            webhook_url,
            "Pipeline Status: Upload Started",
            "Transferring to R2 storage.",
        )
        run_command(
            [
                "aws", "s3", "cp",
                final_output,
                f"s3://{r2_bucket}/{file_uuid}.mp4",
                "--endpoint-url", r2_endpoint,
            ],
            "R2 Upload",
            webhook_url,
        )

        send_discord_notification(
            webhook_url,
            "Pipeline Status: Success",
            "Movie successfully pushed to cloud storage.\n**File:** `" + file_uuid + ".mp4`",
            color=DISCORD_COLOR_SUCCESS,
        )

    except Exception as exc:
        send_discord_notification(
            webhook_url,
            "Pipeline Status: Unhandled Error",
            "```\n" + type(exc).__name__ + ": " + str(exc) + "\n```",
            color=DISCORD_COLOR_ERROR,
        )
        raise

    finally:
        cleanup(download_dir, final_output)


_API_KEY = os.environ.get("PIPELINE_API_KEY", "")


@app.function()
@modal.fastapi_endpoint(method="POST")
def trigger_pipeline(data: Dict[str, Any]) -> Dict[str, str]:
    from fastapi import HTTPException

    provided_key = data.get("api_key", "")
    if not _API_KEY:
        raise HTTPException(status_code=500, detail="Server misconfiguration: PIPELINE_API_KEY is not set.")
    if provided_key != _API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized.")

    magnet = data.get("magnet", "")
    try:
        validate_magnet(magnet)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    process_movie.spawn(magnet)
    return {"status": "Tether Agent dispatched to GPU cluster."}
