#!/usr/bin/env python3
"""Run the reproducible STUDIO canvas → generation boundary acceptance suite.

Local synthetic data only. Requires a disposable TEST_DATABASE_URL, npm ci,
Go, ffprobe, ffmpeg and a matching studio-model-router checkout. Output must
be a new private directory. Full case output stays there, outside the repository.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--jobs', type=int, choices=range(1, 17), default=8)
parser.add_argument('--router', type=Path, default=root.parent/'studio-model-router')
args = parser.parse_args()
if not os.getenv('TEST_DATABASE_URL'):
    parser.error('set an explicit disposable TEST_DATABASE_URL')
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False, mode=0o700)
py = sys.executable
router = str(args.router.resolve())


def run(cmd, **env):
    subprocess.run(cmd, cwd=root, env={**os.environ, **{k: str(v) for k, v in env.items()}}, check=True)


def export(key, name, *tests):
    run(['npm', 'run', 'test:web', '--', *['tests/web/'+t+'.test.ts' for t in tests]], **{key: out/name})


export('STUDIO_CANVAS_AUDIT_EXPORT', 'topology', 'canvas-topology-matrix')
export('STUDIO_CANVAS_MODEL_EXPORT', 'profiles.jsonl', 'canvas-catalog-submissions')
export('STUDIO_CANVAS_ACTIONS_EXPORT', 'tools.jsonl', 'image-subfeature-comfy-contract', 'image-semantic-tools')
export('STUDIO_CANVAS_ACTIONS_EXPORT', 'audio.jsonl', 'native-audio-video-shortcut')
export('STUDIO_CANVAS_ALIAS_EXPORT', 'aliases.jsonl', 'execution-video-connections')
lanes = {
    'edits': ['topology-requests.jsonl'], 'credentialed-edits': ['topology-credentialed-requests.jsonl'],
    'timeline': ['topology-timeline.jsonl', '--timeline'], 'live': ['--live'],
    **{name: [name+'.jsonl'] for name in ('profiles', 'tools', 'audio', 'aliases')},
}
summary = {}
for name, inputs in lanes.items():
    d = out/name
    run([py, 'scripts/test-canvas-boundary.py', *[str(out/i) if not i.startswith('--') else i for i in inputs],
         '--jobs', str(args.jobs), '--out', str(d)])
    env = dict(STUDIO_CANVAS_ROUTER_REQUESTS=d/'invocations.json', STUDIO_CANVAS_MEDIA_DIR=d/'media')
    run([py, 'scripts/test-canvas-router-hop.py', '--router', router, '--summary', str(d/'verified.json')], **env)
    if name == 'profiles':
        run([py, 'scripts/test-canvas-router-ingress.py', '--router', router], **env)
    summary[name] = {**json.loads((d/'summary.json').read_text()), **json.loads((d/'verified.json').read_text())}
run([py, 'scripts/test-canvas-media-boundary.py', '--out', str(out/'media-jobs')])
(out/'model-boundaries.json').write_text(json.dumps(summary, indent=2)+'\n')
print(f'Verified {sum(s["verifiedRequests"] for s in summary.values())} captured generation requests. Evidence: {out}')
