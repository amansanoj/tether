import os
import json
import shlex
import subprocess
import urllib.request
import glob
import uuid
import re
from typing import Any, Dict, Optional, Tuple

import modal

# ---------------------------------------------------------------------------
# Discord embed colors
# Primary   #fdeca0 -> 16641184  top-level pipeline events
# Secondary #79e2ce ->  8053198  subprocess events (encoding progress)
# Accent    #3fd555 ->  4183381  success / error terminal states
# ---------------------------------------------------------------------------

DISCORD_COLOR_PRIMARY   = 16641184   # #fdeca0 — pipeline lifecycle events
DISCORD_COLOR_SECONDARY =  8053198   # #79e2ce — subprocess / encoding progress
DISCORD_COLOR_SUCCESS   =  4183381   # #3fd555 — pipeline completed
DISCORD_COLOR_ERROR     = 15158332   # red     — failures

DISCORD_API = "https://discord.com/api/v10"

MAGNET_PREFIX = "magnet:?"

# ---------------------------------------------------------------------------
# Custom emoji  (<:name:id>  — static PNG, server: amansanoj)
# ---------------------------------------------------------------------------

TH_DOWNLOAD  = "<:th_download:1521089240220569720>"
TH_DONE      = "<:th_done:1521089238299443282>"
TH_REMUX     = "<:th_remux:1521089236340838531>"
TH_TRANSCODE = "<:th_transcode:1521100587557720095>"
TH_UPLOAD    = "<:th_upload:1521089233090248734>"
TH_WARNING   = "<:th_warning:1521089231118929931>"
TH_ENCODING  = "<:th_encoding:1521089228505747568>"
TH_BAR_FILL  = "<:th_bar_fill:1521089226219978802>"
TH_BAR_HALF  = "<:th_bar_half:1521100589793022003>"
TH_BAR_EMPTY = "<:th_bar_empty:1521089224529678396>"
TH_SUCCESS   = "<:th_success:1521089222927192095>"
TH_ERROR     = "<:th_error:1521089220457009252>"

# ---------------------------------------------------------------------------
# Machine images
# ---------------------------------------------------------------------------

transcoder_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "aria2", "awscli")
    .env({
        "AWS_DEFAULT_REGION": "auto",
        "AWS_REGION": "auto",
    })
)

webhook_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("fastapi[standard]")
)

app = modal.App("tether-agent")

# ---------------------------------------------------------------------------
# Discord bot client
# ---------------------------------------------------------------------------

class DiscordBot:
    """
    Thin wrapper around the Discord REST API for a bot token.

    Supports sending a new embed and editing it in place — which is the whole
    point of using a bot over a plain webhook. Lifecycle events (download
    started, transcode started, etc.) each get their own persistent message
    that gets updated rather than spawning a new one per progress tick.

    Secrets required in Modal:
        DISCORD_BOT_TOKEN  — bot token from the Discord developer portal
        DISCORD_CHANNEL_ID — ID of the channel to post in (enable developer
                             mode in Discord, right-click the channel, Copy ID)
    """

    def __init__(self, token: Optional[str], channel_id: Optional[str]) -> None:
        self.token      = token
        self.channel_id = channel_id
        self._enabled   = bool(token and channel_id)

    def _request(self, method: str, path: str, payload: dict) -> Optional[dict]:
        if not self._enabled:
            return None
        url  = f"{DISCORD_API}{path}"
        data = json.dumps(payload).encode("utf-8")
        req  = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bot {self.token}",
                "User-Agent": "TetherAgent/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except Exception as exc:
            print(f"[Discord] {method} {path} failed: {exc}")
            return None

    def send(self, title: str, description: str, color: int = DISCORD_COLOR_PRIMARY) -> Optional[str]:
        """Post a new embed. Returns the message_id, or None on failure."""
        result = self._request(
            "POST",
            f"/channels/{self.channel_id}/messages",
            {"embeds": [{"title": title, "description": description[:2000], "color": color}]},
        )
        return result["id"] if result else None

    def edit(self, message_id: str, title: str, description: str, color: int = DISCORD_COLOR_PRIMARY) -> None:
        """Edit an existing embed in place."""
        self._request(
            "PATCH",
            f"/channels/{self.channel_id}/messages/{message_id}",
            {"embeds": [{"title": title, "description": description[:2000], "color": color}]},
        )

    def send_or_edit(
        self,
        title: str,
        description: str,
        color: int = DISCORD_COLOR_PRIMARY,
        message_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Edit message_id if one is provided, otherwise send a new message.
        Returns the message_id so the caller can hold onto it for future edits.
        """
        if message_id:
            self.edit(message_id, title, description, color)
            return message_id
        return self.send(title, description, color)



def build_progress_bar(percent: int, width: int = 10) -> str:
    """
    Each slot represents 10%. A half block represents 5%.
    So a percent value is mapped across 10 slots:
      - full slots  = percent // 10
      - half slot   = 1 if (percent % 10) >= 5 else 0
      - empty slots = remainder
    """
    full  = percent // 10
    half  = 1 if (percent % 10) >= 5 else 0
    empty = width - full - half
    return TH_BAR_FILL * full + TH_BAR_HALF * half + TH_BAR_EMPTY * empty + f"  **{percent}%**"


def format_eta(seconds: float) -> str:
    """
    Converts a raw second count into a human-readable time string.
    Drops leading zero units so '0h 4m 12s' becomes '4m 12s'.
    """
    seconds = max(0, int(seconds))
    h, remainder = divmod(seconds, 3600)
    m, s = divmod(remainder, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def run_command(
    command: list[str],
    step_name: str,
    bot: "DiscordBot",
    total_duration: float = 0.0,
    progress_message_id: Optional[str] = None,
) -> None:
    """
    Run a subprocess, streaming output to stdout.

    When total_duration is provided, parses ffmpeg progress lines and edits
    progress_message_id in place on each 5% boundary. A single Discord message
    is updated rather than a new one sent per tick.
    """
    cmd_str = " ".join(shlex.quote(a) for a in command)
    print(f"\n[{step_name}] {cmd_str}")

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    output_lines: list[str] = []
    last_reported_percent = 0
    time_pattern  = re.compile(r"time=(\d{2}):(\d{2}):(\d{2}\.\d+)")
    speed_pattern = re.compile(r"speed=\s*(\d+(?:\.\d+)?)x")

    for line in process.stdout:  # type: ignore[union-attr]
        print(line, end="")
        output_lines.append(line)
        if len(output_lines) > 50:
            output_lines.pop(0)

        if total_duration > 0 and progress_message_id:
            time_match = time_pattern.search(line)
            if time_match:
                h, m, s = time_match.groups()
                elapsed  = int(h) * 3600 + int(m) * 60 + float(s)
                percent  = int((elapsed / total_duration) * 100)

                boundary = (percent // 5) * 5
                if boundary > last_reported_percent and boundary < 100:
                    last_reported_percent = boundary
                    bar = build_progress_bar(boundary)

                    # speed=Nx: N seconds of source encoded per wall-clock second.
                    # Remaining wall time = (total - elapsed) / speed.
                    eta_str = "calculating..."
                    speed_match = speed_pattern.search(line)
                    if speed_match:
                        speed = float(speed_match.group(1))
                        if speed > 0:
                            eta_str = format_eta((total_duration - elapsed) / speed)

                    bot.edit(
                        progress_message_id,
                        title=f"{TH_ENCODING} Encoding — {boundary}%",
                        description=f"{bar}\nETA: {eta_str}",
                        color=DISCORD_COLOR_SECONDARY,
                    )

    process.wait()

    if process.returncode != 0:
        tail = "".join(output_lines[-50:])
        bot.send(
            title=f"{TH_ERROR} Step failed: {step_name}",
            description=f"{'`'*3}\n{tail}\n{'`'*3}",
            color=DISCORD_COLOR_ERROR,
        )
        raise RuntimeError(f"'{step_name}' exited with code {process.returncode}")


def get_codecs(file_path: str) -> Tuple[Optional[str], Optional[str]]:
    try:
        raw = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,codec_name",
                "-of", "json",
                file_path,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        streams = json.loads(raw).get("streams", [])
        v = next((s["codec_name"] for s in streams if s.get("codec_type") == "video"), None)
        a = next((s["codec_name"] for s in streams if s.get("codec_type") == "audio"), None)
        return v, a
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffprobe failed on '{file_path}': {exc}") from exc


def get_video_duration(file_path: str) -> float:
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        return float(out)
    except Exception:
        return 0.0


def get_file_info(file_path: str) -> str:
    """
    Pulls file metadata and stream details via a single ffprobe call and
    returns a pre-formatted Discord code block ready to drop into a notification.
    """
    size_bytes = os.path.getsize(file_path)
    if size_bytes >= 1 << 30:
        size_str = f"{size_bytes / (1 << 30):.2f} GB"
    else:
        size_str = f"{size_bytes / (1 << 20):.1f} MB"

    try:
        raw = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-show_entries",
                "format=duration,bit_rate,nb_streams"
                ":stream=codec_type,codec_name,profile,width,height,"
                "r_frame_rate,bit_rate,channel_layout,sample_rate,nb_read_frames",
                "-of", "json",
                file_path,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        data = json.loads(raw)
    except Exception:
        return f"filename : {os.path.basename(file_path)}\nsize     : {size_str}\n(ffprobe metadata unavailable)"

    fmt      = data.get("format", {})
    streams  = data.get("streams", [])
    duration = float(fmt.get("duration", 0))
    br_total = int(fmt.get("bit_rate", 0))

    dur_str = format_eta(duration) if duration else "unknown"
    br_str  = f"{br_total // 1000} kbps" if br_total else "unknown"

    lines = [
        f"file  {os.path.basename(file_path)}",
        f"size  {size_str}  {dur_str}  {br_str}",
    ]

    for s in streams:
        kind = s.get("codec_type", "unknown")
        if kind == "video":
            fps_raw = s.get("r_frame_rate", "")
            try:
                num, den = fps_raw.split("/")
                fps = f"{int(num) / int(den):.4g}fps"
            except Exception:
                fps = fps_raw or "?"
            sbr = int(s.get("bit_rate", 0))
            sbr_str = f"{sbr // 1000}k" if sbr else "?"
            lines.append(
                f"video  {s.get('codec_name', '?')}  "
                f"{s.get('width')}x{s.get('height')}  {fps}  {sbr_str}"
            )
        elif kind == "audio":
            sbr = int(s.get("bit_rate", 0))
            sbr_str = f"{sbr // 1000}k" if sbr else "?"
            ch = s.get("channel_layout", "?").replace("(side)", "")
            lines.append(
                f"audio  {s.get('codec_name', '?')}  {ch}  {sbr_str}"
            )
        elif kind == "subtitle":
            lines.append(f"sub  {s.get('codec_name', '?')}")

    return "```\n" + "\n".join(lines) + "\n```"


def validate_magnet(magnet: str) -> None:
    if not magnet or not magnet.startswith(MAGNET_PREFIX):
        raise ValueError(
            f"Not a valid magnet link. Expected prefix '{MAGNET_PREFIX}', got: {magnet!r}"
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
            print(f"[Cleanup] Could not remove {path}: {exc}")


# ---------------------------------------------------------------------------
# GPU worker
# ---------------------------------------------------------------------------

def transcode_and_upload(
    source_file: str,
    output_path: str,
    r2_bucket: str,
    r2_key: str,
    r2_endpoint: str,
    bot: "DiscordBot",
    label: str,
) -> None:
    """
    Transcode or remux a single source file to output_path, then upload to R2.
    label is used in notification titles to identify the file (e.g. 'S01E03').
    """
    v_codec, a_codec = get_codecs(source_file)

    if v_codec == "h264" and a_codec == "aac":
        bot.send(
            title=f"{TH_REMUX} Remux started — {label}",
            description=(
                f"Codecs already compatible ({v_codec} / {a_codec}). "
                "Remuxing container — no re-encode required."
            ),
        )
        run_command(
            ["ffmpeg", "-hide_banner", "-y", "-i", source_file, "-c", "copy", output_path],
            f"Remux {label}",
            bot,
        )
    else:
        # Send a progress message and hold its ID so run_command can edit it in place.
        progress_msg_id = bot.send(
            title=f"{TH_TRANSCODE} Transcode started — {label}",
            description=(
                f"Codecs not web-compatible ({v_codec} / {a_codec}). "
                "Spinning up T4 hardware encoder."
            ),
            color=DISCORD_COLOR_SECONDARY,
        )
        duration = get_video_duration(source_file)
        run_command(
            [
                "ffmpeg", "-hide_banner", "-y",
                "-hwaccel", "cuda",
                "-i", source_file,
                "-map", "0:v:0", "-map", "0:a", "-map", "0:s?",
                "-map_metadata", "0",
                "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq",
                "-b:v", "3M", "-maxrate", "3.5M", "-bufsize", "6M",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "320k",
                "-c:s", "mov_text",
                output_path,
            ],
            f"Transcode {label}",
            bot,
            total_duration=duration,
            progress_message_id=progress_msg_id,
        )
        # Stamp the final state onto the progress message rather than leaving
        # it sitting at 95% when the encode finishes.
        if progress_msg_id:
            bot.edit(
                progress_msg_id,
                title=f"{TH_DONE} Transcode complete — {label}",
                description=f"{build_progress_bar(100)}\nEncode finished.",
                color=DISCORD_COLOR_PRIMARY,
            )

    bot.send(
        title=f"{TH_UPLOAD} Upload started — {label}",
        description=f"Transferring `{r2_key}` to R2.",
    )
    run_command(
        [
            "aws", "s3", "cp",
            output_path,
            f"s3://{r2_bucket}/{r2_key}",
            "--endpoint-url", r2_endpoint,
        ],
        f"Upload {label}",
        bot,
    )
    cleanup(output_path)


@app.function(
    image=transcoder_image,
    gpu="T4",
    timeout=14400,
    secrets=[modal.Secret.from_name("tether-agent")],
)
def process_movie(magnet_link: str) -> None:
    os.environ["AWS_ACCESS_KEY_ID"]     = os.environ.get("R2_ACCESS_KEY_ID", "")
    os.environ["AWS_SECRET_ACCESS_KEY"] = os.environ.get("R2_SECRET_ACCESS_KEY", "")

    bot = DiscordBot(
        token=os.environ.get("DISCORD_BOT_TOKEN"),
        channel_id=os.environ.get("DISCORD_CHANNEL_ID"),
    )
    r2_endpoint = os.environ.get("R2_ENDPOINT_URL")
    r2_bucket   = os.environ.get("R2_BUCKET", "movies")

    if not r2_endpoint:
        raise RuntimeError("R2_ENDPOINT_URL is not configured.")

    batch_uuid   = str(uuid.uuid4())
    download_dir = f"/tmp/torrent-{batch_uuid}"

    try:
        validate_magnet(magnet_link)

        # -- Step 1: Download -------------------------------------------------
        bot.send(
            title=f"{TH_DOWNLOAD} Download started",
            description="Torrent download dispatched to Modal. Waiting on peers.",
        )
        run_command(
            [
                "aria2c",
                "--seed-time=0",
                "--summary-interval=5",
                "--max-overall-upload-limit=1K",
                "--enable-dht6=false",   # IPv6 unavailable on Modal, don't waste time
                f"--dir={download_dir}",
                magnet_link,
            ],
            "Torrent download",
            bot,
        )

        # -- Step 2: Locate all video files, sorted by name -------------------
        video_files = sorted(
            glob.glob(f"{download_dir}/**/*.mkv", recursive=True)
            + glob.glob(f"{download_dir}/**/*.mp4", recursive=True)
            + glob.glob(f"{download_dir}/**/*.avi", recursive=True)
        )
        if not video_files:
            raise RuntimeError("No video files found after download completed.")

        is_series = len(video_files) > 1

        if is_series:
            total_size = sum(os.path.getsize(f) for f in video_files)
            size_gb    = total_size / (1 << 30)
            file_list  = "\n".join(f"  {os.path.basename(f)}" for f in video_files)
            bot.send(
                title=f"{TH_DONE} Download complete — {len(video_files)} episodes ({size_gb:.2f} GB total)",
                description=f"```\n{file_list}\n```",
            )
        else:
            bot.send(
                title=f"{TH_DONE} Download complete",
                description=get_file_info(video_files[0]),
            )

        # -- Step 3 & 4: Transcode + upload each file -------------------------
        uploaded: list[str] = []
        failed:   list[str] = []

        for i, source_file in enumerate(video_files, start=1):
            stem     = os.path.splitext(os.path.basename(source_file))[0]
            r2_key   = f"{batch_uuid}/{stem}.mp4" if is_series else f"{batch_uuid}.mp4"
            out_path = f"/tmp/{batch_uuid}_{i}.mp4"
            label    = f"{i}/{len(video_files)} — {stem}" if is_series else stem

            try:
                transcode_and_upload(
                    source_file=source_file,
                    output_path=out_path,
                    r2_bucket=r2_bucket,
                    r2_key=r2_key,
                    r2_endpoint=r2_endpoint,
                    bot=bot,
                    label=label,
                )
                uploaded.append(r2_key)
            except Exception as exc:
                failed.append(stem)
                bot.send(
                    title=f"{TH_WARNING} Episode failed — {stem}",
                    description=f"```\n{type(exc).__name__}: {exc}\n```\nContinuing with remaining files.",
                    color=DISCORD_COLOR_ERROR,
                )

        # -- Step 5: Summary --------------------------------------------------
        if failed and not uploaded:
            raise RuntimeError(f"All {len(failed)} file(s) failed. See above for details.")

        if is_series:
            summary_lines = [f"  {k}" for k in uploaded]
            if failed:
                summary_lines += [f"  FAILED: {f}" for f in failed]
            bot.send(
                title=f"{TH_SUCCESS} Pipeline complete — {len(uploaded)}/{len(video_files)} uploaded",
                description="```\n" + "\n".join(summary_lines) + "\n```",
                color=DISCORD_COLOR_SUCCESS if not failed else DISCORD_COLOR_ERROR,
            )
        else:
            bot.send(
                title=f"{TH_SUCCESS} Pipeline complete",
                description=f"File stored at `{uploaded[0]}`.",
                color=DISCORD_COLOR_SUCCESS,
            )

    except Exception as exc:
        bot.send(
            title=f"{TH_ERROR} Pipeline failed",
            description=f"{'`'*3}\n{type(exc).__name__}: {exc}\n{'`'*3}",
            color=DISCORD_COLOR_ERROR,
        )
        raise

    finally:
        # transcode_and_upload cleans up its own output files after each upload.
        # Only the download directory needs to be removed here.
        cleanup(download_dir)


# ---------------------------------------------------------------------------
# HTTP trigger
# ---------------------------------------------------------------------------

_API_KEY = os.environ.get("PIPELINE_API_KEY", "")


@app.function(
    image=webhook_image,
    secrets=[modal.Secret.from_name("tether-agent")],
)
@modal.fastapi_endpoint(method="POST")
def trigger_pipeline(data: Dict[str, Any]) -> Dict[str, str]:
    from fastapi import HTTPException

    provided_key = data.get("api_key", "")
    if not _API_KEY:
        raise HTTPException(status_code=500, detail="PIPELINE_API_KEY is not set on the server.")
    if provided_key != _API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key.")

    magnet = data.get("magnet", "")
    try:
        validate_magnet(magnet)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    process_movie.spawn(magnet)
    return {"status": "Pipeline dispatched."}
