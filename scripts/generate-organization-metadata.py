"""Reapply canonical operation metadata without modifying frozen v1 contracts."""
import json
from pathlib import Path
import yaml
root = Path(__file__).resolve().parents[1]
p = root / "contracts/organization-extension.json"
spec = json.loads(p.read_text())
for methods in spec["paths"].values():
    for method, operation in methods.items():
        if method in {"get", "post", "put", "delete", "patch"}:
            operation["x-implementation-status"] = "IMPLEMENTED"
            operation["x-required-capability"] = "tv.access"
p.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
(root / "contracts/organization-extension.yaml").write_text(yaml.safe_dump(spec, allow_unicode=True, sort_keys=False))
