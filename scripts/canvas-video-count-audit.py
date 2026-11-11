"""Enumerate video input quantities against the service rules (no network).
With --write, regenerate the individual cases and summary; otherwise check them.
"""
import argparse, collections, csv, io, itertools, json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
fixture = root / "tests/web/fixtures/canvas-catalog-audit-20261104.json"
out = root / "docs/acceptance"
kinds = ("IMAGE", "VIDEO", "AUDIO")

def category(s, counts):
    i, v, a = counts
    limits = s["x-media-limits"]
    shape = s.get("x-input-constraints", {})
    mode = s["x-video-mode"]
    # Router manifest_execution.go counts per kind and total; officialvideo
    # executor.go separately enforces frame arity and any-media/visual policy.
    if any(n > limits.get(k, 0) for k, n in zip(kinds, counts)) or sum(counts) > shape.get("max_references", s.get("x-media-total-limit", sum(limits.values()))):
        return "forbidden"
    if i < shape.get("min_images", 0) or v < shape.get("min_videos", 0):
        return "incomplete"
    if mode in {"FIRST_FRAME", "LAST_FRAME", "FIRST_LAST_FRAME"} and i < (2 if mode == "FIRST_LAST_FRAME" else 1):
        return "incomplete"
    if mode == "OMNI_REFERENCE" and (not sum(counts) or not i + v and s.get("x-reference-requirement") != "ANY_MEDIA"):
        return "incomplete"
    return "ready"

def render():
    result = io.StringIO()
    writer = csv.writer(result, lineterminator="\n")
    writer.writerow(["model","version","image","video","audio","with_access","without_personal_key"])
    stats = collections.Counter()
    by_access = collections.defaultdict(collections.Counter)
    summary = ["# 视频生成：素材数量核算（2026-11-04）","","每行是一条公开型号和参数版本。对图、视频、音频分别从零枚举到该型号上限再加一项，涵盖所有合法数量与首次越界。各素材为不同、已准备好的资产；按角色使用，尺寸、时长、描述、人物配对和输出规格另验。操作次数和素材身份不是本表的计数维度。","", "“可提交 / 待补 / 禁止”按有权使用该型号统计。待补表示可继续连线但不能运行；禁止表示必须先移除或替换输入。需个人密钥的型号在未配置时三个分类都不可提交。","", "| 型号 | 版本 | 使用条件 | 可提交 | 待补 | 禁止 |","|---|---:|---|---:|---:|---:|"]
    for r in json.loads(fixture.read_text()):
        if r["testMode"] or not r.get("model") or "VIDEO" not in r["outputKinds"]:
            continue
        s = r["parameterSchema"]; totals = collections.Counter(); access = "当前开放" if r["available"] else "需个人密钥"
        for counts in itertools.product(*(range(s["x-media-limits"].get(k, 0) + 2) for k in kinds)):
            val = category(s, counts)
            writer.writerow([r["capabilityRef"],r["version"],*counts,val,val if r["available"] else "disabled"])
            stats[val] += 1; totals[val] += 1; by_access[access][val] += 1
        stats["models"] += 1
        summary.append(f'| {r["capabilityRef"]} | {r["version"]} | {access} | {totals["ready"]} | {totals["incomplete"]} | {totals["forbidden"]} |')
    summary.extend(["",f'合计 {stats["models"]} 个型号/模式，{stats["ready"] + stats["incomplete"] + stats["forbidden"]} 行：{stats["ready"]} 可提交、{stats["incomplete"]} 待补、{stats["forbidden"]} 禁止。'])
    for access,t in by_access.items():
        summary.append(f'- {access}：{sum(t.values())} 行；{t["ready"]} 可提交、{t["incomplete"]} 待补、{t["forbidden"]} 禁止（按具备使用条件统计）。')
    summary+=["","[逐项 CSV](canvas-video-counts.csv)；前端一致性验算见 tests/web/canvas-video-counts.test.ts，以真实连线许可与提交校验函数比对。不会发起生成。"]
    return {"canvas-video-counts.csv":result.getvalue(),"canvas-video-counts.md":"\n".join(summary)+"\n"}

if __name__ == "__main__":
    args=argparse.ArgumentParser();args.add_argument("--write",action="store_true");write=args.parse_args().write
    for file,content in render().items():
        if write: (out/file).write_text(content)
        elif not (out/file).is_file() or (out/file).read_text()!=content: raise SystemExit(f"out of date: {file}")
