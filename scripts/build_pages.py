#!/usr/bin/env python3
"""Build the public Quill artifact for a static host."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = (
    Path("index.html"),
    Path("styles.css"),
    Path("app.js"),
    Path("data/metax-context.json"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "_site",
        help="Directory to receive the static artifact (default: ./_site)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = args.output.expanduser().resolve()

    if output == PROJECT_ROOT or PROJECT_ROOT not in output.parents:
        raise SystemExit("Output must be a child directory of the Quill project.")

    missing = [str(path) for path in PUBLIC_FILES if not (PROJECT_ROOT / path).is_file()]
    if missing:
        raise SystemExit(f"Missing required public files: {', '.join(missing)}")

    context_path = PROJECT_ROOT / "data/metax-context.json"
    with context_path.open(encoding="utf-8") as context_file:
        json.load(context_file)

    output.mkdir(parents=True, exist_ok=True)
    for relative_path in PUBLIC_FILES:
        destination = output / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PROJECT_ROOT / relative_path, destination)

    (output / ".nojekyll").touch()
    print(f"Built {len(PUBLIC_FILES)} public files in {output}")


if __name__ == "__main__":
    main()
