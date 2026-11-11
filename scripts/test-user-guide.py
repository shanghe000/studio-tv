#!/usr/bin/env python3
"""Small, offline contract checks for the maintainable user-guide builder."""

import base64
import copy
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest


BUILDER_PATH = Path(__file__).with_name("build-user-guide.py")
SPEC = importlib.util.spec_from_file_location("build_user_guide", BUILDER_PATH)
guide = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guide)


class Tags(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.tags = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


class GuideBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "content"
        self.images = self.root / "images"
        self.source.mkdir()
        self.images.mkdir()
        self.original_source, self.original_images = guide.SOURCE, guide.IMAGES
        guide.SOURCE, guide.IMAGES = self.source, self.images
        self.config = {
            "schemaVersion": 1,
            "title": "指南",
            "returnHref": "/projects/",
            "returnLabel": "返回工作台",
            "sections": [{"id": "s1", "number": "01", "title": "画布", "source": "section.html"}],
            "groups": {"tools": {"section": "s1", "title": "图片工具"}, "empty": {"section": "s1", "title": "空组"}},
        }
        self.item = {
            "id": "tool-panel",
            "group": "tools",
            "file": "tool.png",
            "caption": "打开工具 <查看>",
            "alt": "工具面板",
            "steps": ["选中图片。", "调整后生成。"],
        }
        self.raw = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", 1600, 900)
        (self.images / "tool.png").write_bytes(self.raw)
        (self.source / "section.html").write_text('<section id="s1"><p>正文保持。</p>{{gallery:tools}}{{gallery:empty}}</section>', encoding="utf-8")
        (self.source / "styles.css").write_text("body{color:#222}", encoding="utf-8")
        (self.source / "interaction.js").write_text("void 0;", encoding="utf-8")
        self.save()

    def tearDown(self):
        guide.SOURCE, guide.IMAGES = self.original_source, self.original_images
        self.temp.cleanup()

    def save(self, items=None):
        (self.source / "guide.json").write_text(json.dumps(self.config, ensure_ascii=False), encoding="utf-8")
        (self.source / "screenshots.json").write_text(json.dumps({"schemaVersion": 1, "items": items if items is not None else [self.item]}, ensure_ascii=False), encoding="utf-8")

    def test_online_disclosure_is_closed_and_images_are_lazy_with_dimensions(self):
        text = guide.GuideBuilder().render()
        tags = Tags(text).tags
        details = [attrs for tag, attrs in tags if tag == "details"]
        self.assertEqual(len(details), 1)
        self.assertNotIn("open", details[0])
        images = [attrs for tag, attrs in tags if tag == "img" and attrs.get("src")]
        self.assertEqual(len(images), 1)
        self.assertRegex(images[0]["src"], r"^images/tool\.png\?v=[0-9a-f]{16}$")
        self.assertEqual({key: value for key, value in images[0].items() if key != "src"}, {"alt": "工具面板", "width": "1600", "height": "900", "loading": "lazy", "decoding": "async"})
        self.assertIn("打开工具 &lt;查看&gt;", text)
        self.assertIn("正文保持。", text)
        self.assertNotIn("空组", text)

    def test_standalone_embeds_the_same_source_bytes_and_build_is_repeatable(self):
        builder = guide.GuideBuilder()
        text = builder.render(standalone=True)
        images = [attrs for tag, attrs in Tags(text).tags if tag == "img" and attrs.get("src")]
        self.assertEqual(base64.b64decode(images[0]["src"].split(",", 1)[1]), self.raw)
        self.assertEqual(text, builder.render(standalone=True))

    def test_replacing_same_named_image_changes_its_cache_address(self):
        first = next(attrs["src"] for tag, attrs in Tags(guide.GuideBuilder().render()).tags if tag == "img" and attrs.get("src"))
        (self.images / "tool.png").write_bytes(self.raw + b"replacement image content")
        second = next(attrs["src"] for tag, attrs in Tags(guide.GuideBuilder().render()).tags if tag == "img" and attrs.get("src"))
        self.assertEqual(first.split("?", 1)[0], second.split("?", 1)[0])
        self.assertNotEqual(first, second)

    def test_missing_or_out_of_tree_image_is_rejected(self):
        for filename in ("missing.png", "../outside.png", str(self.root / "tool.png")):
            with self.subTest(filename=filename):
                self.item["file"] = filename
                self.save()
                with self.assertRaises(guide.GuideError):
                    guide.GuideBuilder()

    def test_dimensions_and_step_limit_are_verified(self):
        self.item.update({"width": 100, "height": 100})
        self.save()
        with self.assertRaisesRegex(guide.GuideError, "dimensions do not match"):
            guide.GuideBuilder()
        self.item.pop("width")
        self.item.pop("height")
        self.item["steps"] = ["步骤"] * 4
        self.save()
        with self.assertRaisesRegex(guide.GuideError, "at most three"):
            guide.GuideBuilder()

    def test_unknown_group_or_unplaced_screenshot_is_rejected(self):
        self.item["group"] = "unknown"
        self.save()
        with self.assertRaisesRegex(guide.GuideError, "Unknown screenshot group"):
            guide.GuideBuilder()
        self.item.pop("group")
        self.save()
        with self.assertRaisesRegex(guide.GuideError, "lack a content placement"):
            guide.GuideBuilder().render()

    def test_manifest_order_is_used_and_duplicate_ids_are_rejected(self):
        second = copy.deepcopy(self.item)
        second.update({"id": "second-tool", "order": 1})
        self.item["order"] = 2
        self.save([self.item, second])
        text = guide.GuideBuilder().render()
        self.assertLess(text.index('id="figure-second-tool"'), text.index('id="figure-tool-panel"'))
        self.save([self.item, self.item])
        with self.assertRaisesRegex(guide.GuideError, "duplicate screenshot ID"):
            guide.GuideBuilder()


if __name__ == "__main__":
    unittest.main()
