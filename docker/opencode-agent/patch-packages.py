#!/usr/bin/env python3
"""Rewrite package.json files so bun can install the baked plugin."""
import json
from pathlib import Path

for rel in ("package.json", "../shared/package.json"):
    path = Path(rel)
    data = json.loads(path.read_text())
    data.pop("private", None)
    if rel == "package.json":
        data.setdefault("dependencies", {})["@chorus/shared"] = "file:../shared"
    path.write_text(json.dumps(data, indent=2) + "\n")
