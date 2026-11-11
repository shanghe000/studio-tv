#!/usr/bin/env python3
"""Replay signed STUDIO captures at real Router adapters; never call a real provider."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--router', type=Path, default=root.parent / 'studio-model-router')
parser.add_argument('--summary', type=Path, help='Write per-profile counts and an input snapshot digest')
parser.add_argument('--verbose', action='store_true', help='Show individual Go test output')
opts = parser.parse_args()
names = ('h3', 'officialvideo', 'codexappserver')
test = re.compile(r'^TestCanvasAuditLastHop/([^/]+)/(fixture|row-\d+-[0-9a-f]{64})$')


def index_capture(data):
    """Hash original JSON bytes per row; Go independently computes the same digest."""
    decoder, source = json.JSONDecoder(), data.decode('utf-8')
    refs = {row['capabilityRef'] for row in json.loads((root / 'tests/web/fixtures/canvas-catalog-audit-20261104.json').read_text()) if not row['testMode']}
    expected = Counter()
    pos = len(source) - len(source.lstrip())
    if source[pos:pos+1] != '[':
        raise ValueError('Expected a STUDIO invocation array')
    pos += 1
    while pos < len(source):
        while source[pos:pos+1] and source[pos] in ' \t\r\n':
            pos += 1
        if source[pos:pos+1] == ']':
            break
        row, end = decoder.raw_decode(source, pos)
        ref = row['capability']['ref']
        if ref not in refs:
            raise ValueError(f'Unknown capability: {ref}')
        sha = hashlib.sha256(source[pos:end].encode()).hexdigest()
        expected[(ref, f'row-{len(expected)}-{sha}')] += 1
        pos = end
        while source[pos:pos+1] and source[pos] in ' \t\r\n':
            pos += 1
        if source[pos:pos+1] == ']':
            break
        if source[pos:pos+1] != ',':
            raise ValueError('Invalid STUDIO invocation array')
        pos += 1
    if not expected or source[pos:].strip() != ']':
        raise ValueError('Incomplete/empty STUDIO invocation array')
    return expected


with tempfile.TemporaryDirectory() as tmp:
    templates = root / 'tools/canvas-router-audit'
    router = opts.router.resolve()
    overlay, expected, observed, fixtures = {}, Counter(), Counter(), Counter()
    env = os.environ.copy()
    digest = None
    if env.get('STUDIO_CANVAS_ROUTER_REQUESTS'):
        snapshot = Path(tmp) / 'captures.json'
        data = Path(env['STUDIO_CANVAS_ROUTER_REQUESTS']).read_bytes()
        expected = index_capture(data)
        digest = hashlib.sha256(data).hexdigest()
        snapshot.write_bytes(data)
        env['STUDIO_CANVAS_ROUTER_REQUESTS'] = str(snapshot)

    for name in names:
        target = router / 'internal/adapters' / name
        for tag, source in [('contract', (templates / (name + '.inc')).read_text()), ('shared', 'package '+name+'\n'+(templates / 'shared.inc').read_text())]:
            filename = 'studiotv_canvas_' + tag + '_test.go'
            fresh = Path(tmp) / (name + '_' + filename)
            fresh.write_text(source)
            overlay[str(target / filename)] = str(fresh)
    config = Path(tmp) / 'overlay.json'
    config.write_text(json.dumps({'Replace': overlay}))
    cmd = ['go', 'test', '-json', '-mod=vendor', '-count=1', '-overlay', str(config), '-run', '^TestCanvasAuditLastHop$', *['./internal/adapters/'+name for name in names]]
    with subprocess.Popen(cmd, cwd=router, env=env, text=True, stdout=subprocess.PIPE) as proc:
        for line in proc.stdout:
            event = json.loads(line)
            out = event.get('Output', '').rstrip()
            if opts.verbose or (out and not out.startswith(('===', '--- PASS', '    --- PASS', '        --- PASS', 'PASS', 'ok  '))):
                if out:
                    print(out, flush=True)
            if event.get('Action') == 'pass' and (match := test.fullmatch(event.get('Test', ''))):
                ref, case = match.groups()
                if case == 'fixture':
                    fixtures[ref] += 1
                else:
                    observed[ref, case] += 1
        result = proc.wait()
    summary = {
        'captureSha256': digest, 'expectedRequests': sum(expected.values()),
        'verifiedRequests': sum((expected & observed).values()), 'missingRequests': sum((expected-observed).values()),
        'unexpectedReplays': sum((observed-expected).values()),
        'fixtureProfiles': len(fixtures), 'verifiedByProfile': dict(sorted(Counter(ref for ref, case in (expected & observed).elements()).items())),
    }
    if opts.summary:
        opts.summary.write_text(json.dumps(summary, indent=2)+'\n')
    print(f"Final hop: {summary['verifiedRequests']}/{summary['expectedRequests']} original STUDIO captures, {len(summary['verifiedByProfile'])} captured profiles, {len(fixtures)} independent adapter fixtures, {summary['unexpectedReplays']} unexpected replays")
    if result or observed != expected or len(fixtures) != 64 or set(fixtures.values()) != {1}:
        raise SystemExit(result or 1)
