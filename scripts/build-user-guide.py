#!/usr/bin/env python3
"""Build the Studio TV guide from repository-owned content and screenshots.

Python standard library only. Run from any working directory. No browser,
font installation, PDF tool, network request, or original collection folder
is needed. The online guide uses individual images; the optional standalone
export embeds those same image bytes.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
from html.parser import HTMLParser
import json
import mimetypes
from pathlib import Path
import re
import struct
import sys
from urllib.parse import quote


REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "docs/user-guide"
PUBLIC = REPO / "apps/web/public/guide"
IMAGES = PUBLIC / "images"
TOKEN = re.compile(r"\{\{(figure|gallery|figures):([a-z0-9][a-z0-9-]*)\}\}")


class GuideError(ValueError):
    pass


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise GuideError(f"Unsupported guide source schema: {path.name}")
    return value


def local_file(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise GuideError("A source or image must use a nonempty relative path")
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise GuideError(f"Missing or out-of-scope guide file: {name}")
    return path


def image_dimensions(raw: bytes) -> tuple[int, int] | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw) >= 24:
        return struct.unpack(">II", raw[16:24])
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        offset = 12
        while offset + 8 <= len(raw):
            kind = raw[offset : offset + 4]
            size = int.from_bytes(raw[offset + 4 : offset + 8], "little")
            data = raw[offset + 8 : offset + 8 + size]
            if kind == b"VP8X" and len(data) >= 10:
                return 1 + int.from_bytes(data[4:7], "little"), 1 + int.from_bytes(data[7:10], "little")
            if kind == b"VP8L" and len(data) >= 5 and data[0] == 0x2F:
                bits = int.from_bytes(data[1:5], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            if kind == b"VP8 " and len(data) >= 10 and data[3:6] == b"\x9d\x01\x2a":
                return int.from_bytes(data[6:8], "little") & 0x3FFF, int.from_bytes(data[8:10], "little") & 0x3FFF
            offset += 8 + size + size % 2
    return None


def nonempty_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GuideError(f"A screenshot needs nonempty {field}")
    return value.strip()


class DocumentCheck(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.anchors: list[str] = []
        self.image_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        identity = values.get("id")
        if identity:
            if identity in self.ids:
                raise GuideError(f"Duplicate document ID: {identity}")
            self.ids.add(identity)
        if tag == "a" and (values.get("href") or "").startswith("#"):
            self.anchors.append(values["href"][1:])
        if tag == "img" and values.get("src"):
            self.image_count += 1
            if values.get("loading") != "lazy" or values.get("decoding") != "async":
                raise GuideError("Every guide screenshot must load lazily")
            if not values.get("alt") or not values.get("width") or not values.get("height"):
                raise GuideError("Every guide screenshot needs alt text and intrinsic dimensions")


class GuideBuilder:
    def __init__(self) -> None:
        self.config = read_json(SOURCE / "guide.json")
        manifest = read_json(SOURCE / "screenshots.json")
        self.groups = self.config.get("groups", {})
        self.images: dict[str, dict] = {}
        self.used: set[str] = set()
        for index, value in enumerate(manifest.get("items", [])):
            identity = nonempty_text(value.get("id"), "id")
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", identity) or identity in self.images:
                raise GuideError(f"Invalid or duplicate screenshot ID: {identity}")
            group = value.get("group")
            if group is not None and group not in self.groups:
                raise GuideError(f"Unknown screenshot group: {group}")
            path = local_file(IMAGES, value.get("file"))
            if path.suffix.lower() not in {".png", ".webp", ".jpg", ".jpeg"}:
                raise GuideError(f"Unsupported screenshot format: {path.name}")
            raw = path.read_bytes()
            actual = image_dimensions(raw)
            dimensions = (value.get("width"), value.get("height"))
            if dimensions == (None, None):
                dimensions = actual
            if not dimensions or any(type(n) is not int or n <= 0 for n in dimensions):
                raise GuideError(f"Missing screenshot dimensions: {identity}")
            if actual and tuple(dimensions) != actual:
                raise GuideError(f"Screenshot dimensions do not match image bytes: {identity}")
            steps = value.get("steps", [])
            if not isinstance(steps, list) or len(steps) > 3:
                raise GuideError(f"Use at most three steps per screenshot: {identity}")
            if "order" in value and type(value["order"]) is not int:
                raise GuideError(f"Screenshot order must be an integer: {identity}")
            self.images[identity] = {
                **value,
                "caption": nonempty_text(value.get("caption"), "caption"),
                "alt": nonempty_text(value.get("alt"), "alt"),
                "steps": [nonempty_text(step, "step") for step in steps],
                "dimensions": dimensions,
                "raw": raw,
                "fingerprint": hashlib.sha256(raw).hexdigest()[:16],
                "mime": mimetypes.guess_type(path.name)[0],
                "index": index,
            }

    def figure(self, identity: str, standalone: bool) -> str:
        if identity not in self.images:
            raise GuideError(f"Unknown figure placement: {identity}")
        item = self.images[identity]
        self.used.add(identity)
        src = "images/" + quote(item["file"], safe="/") + "?v=" + item["fingerprint"]
        if standalone:
            src = "data:" + item["mime"] + ";base64," + base64.b64encode(item["raw"]).decode("ascii")
        width, height = item["dimensions"]
        caption = html.escape(item["caption"])
        steps = ""
        if item["steps"]:
            steps = '<ol class="figure-steps">' + "".join("<li>" + html.escape(step) + "</li>" for step in item["steps"]) + "</ol>"
        return (
            f'<figure class="guide-figure" id="figure-{identity}">\n'
            f'<button class="image-button" type="button" aria-label="放大：{html.escape(item["caption"], quote=True)}">'
            f'<img src="{src}" alt="{html.escape(item["alt"], quote=True)}" width="{width}" height="{height}" loading="lazy" decoding="async"></button>\n'
            f'<figcaption><strong>{caption}</strong><span class="guide-figure__hint">点击图片放大</span>{steps}</figcaption>\n'
            '</figure>'
        )

    def gallery(self, identity: str, standalone: bool, section: str, disclosure: bool = True) -> str:
        group = self.groups.get(identity)
        if not group or group.get("section") != section:
            raise GuideError(f"Unknown or misplaced guide group: {identity}")
        entries = sorted(
            ((key, value) for key, value in self.images.items() if value.get("group") == identity),
            key=lambda row: (row[1].get("order", row[1]["index"]), row[1]["index"]),
        )
        if not entries:
            return ""
        columns = group.get("columns", 2 if len(entries) > 1 else 1)
        if columns not in (1, 2):
            raise GuideError(f"A gallery supports one or two columns: {identity}")
        figures = "\n".join(self.figure(key, standalone) for key, _ in entries)
        body = f'<div class="guide-gallery guide-gallery--{columns}">\n{figures}\n</div>'
        if not disclosure:
            return body
        return (
            f'<details class="guide-details" id="{identity}">\n'
            f'<summary>{html.escape(group["title"])}<span class="guide-details__count">{len(entries)} 张图</span></summary>\n'
            f'<div class="guide-details__body">{body}</div>\n</details>'
        )

    def render(self, standalone: bool = False) -> str:
        self.used.clear()
        sections = []
        nav = []
        for entry in self.config["sections"]:
            identity = entry["id"]
            text = local_file(SOURCE, entry["source"]).read_text(encoding="utf-8").strip()
            if not re.search(r'<section\s+id="' + re.escape(identity) + '"', text):
                raise GuideError(f"Section source ID does not match its entry: {identity}")
            def replace(match: re.Match) -> str:
                kind, name = match.groups()
                return self.figure(name, standalone) if kind == "figure" else self.gallery(name, standalone, identity, kind == "gallery")
            text = TOKEN.sub(replace, text)
            if "{{" in text:
                raise GuideError(f"Unresolved guide placeholder: {identity}")
            sections.append(text)
            nav.append(f'<a href="#{identity}">{html.escape(entry["number"])} {html.escape(entry["title"])}</a>')
        if self.used != self.images.keys():
            raise GuideError("Screenshots lack a content placement: " + ", ".join(sorted(self.images.keys() - self.used)))
        title = html.escape(self.config["title"])
        css = (SOURCE / "styles.css").read_text(encoding="utf-8").strip()
        script = (SOURCE / "interaction.js").read_text(encoding="utf-8").strip()
        reading_hint = self.config.get("readingHint", "")
        reading_hint = f'<p class="reading-tip">{html.escape(reading_hint)}</p>\n' if reading_hint else ""
        document = (
            '<!doctype html>\n<!-- Generated from docs/user-guide by scripts/build-user-guide.py. -->\n'
            f'<html lang="{html.escape(self.config.get("language", "zh-CN"), quote=True)}">\n<head>\n<meta charset="UTF-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<title>{title}</title>\n<style>\n{css}\n</style>\n</head>\n<body>\n'
            f'<header><div class="header-title"><h1>{title}</h1>'
            f'<a class="back-link" href="{html.escape(self.config["returnHref"], quote=True)}">{html.escape(self.config["returnLabel"])}</a></div>\n'
            + reading_hint + '<nav aria-label="指南章节">' + "".join(nav) + '</nav></header>\n<main>\n'
            + "\n".join(sections) + '\n</main>\n'
            '<dialog class="screenshot-preview" aria-label="截图预览"><div class="screenshot-preview__heading"><p class="screenshot-preview__caption"></p>'
            '<button class="screenshot-preview__zoom" type="button" aria-pressed="false">原图尺寸</button>'
            '<button class="screenshot-preview__close" type="button" aria-label="关闭预览">×</button></div>'
            '<img alt="截图放大预览"></dialog>\n'
            f'<script>\n{script}\n</script>\n</body>\n</html>\n'
        )
        parser = DocumentCheck()
        parser.feed(document)
        if any(anchor not in parser.ids for anchor in parser.anchors):
            raise GuideError("A guide navigation link has no target")
        return document


def write_or_check(path: Path, content: str, check: bool) -> None:
    if check:
        if not path.is_file() or path.read_text(encoding="utf-8") != content:
            raise GuideError(f"Generated guide is out of date: {path}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate sources and fail if generated outputs are stale")
    parser.add_argument("--self-contained-output", type=Path, help="also produce a standalone HTML file with embedded screenshot bytes")
    args = parser.parse_args()
    try:
        builder = GuideBuilder()
        write_or_check(PUBLIC / "index.html", builder.render(), args.check)
        if args.self_contained_output:
            if args.self_contained_output.suffix.lower() != ".html":
                raise GuideError("The standalone output must be an HTML file")
            write_or_check(args.self_contained_output, builder.render(standalone=True), args.check)
        print(f'Guide {"checked" if args.check else "built"}: {len(builder.config["sections"])} sections, {len(builder.images)} screenshots')
        return 0
    except (GuideError, OSError, json.JSONDecodeError) as error:
        print(f"Guide build failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
