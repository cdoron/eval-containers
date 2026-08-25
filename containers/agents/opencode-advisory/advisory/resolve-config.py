#!/usr/bin/env python3
"""Resolve one named string from the advisory configuration catalog."""

import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: resolve-config.py <section> <variant>", file=sys.stderr)
        return 2
    section, variant = sys.argv[1:]
    raw = os.getenv("EVAL_ADVISORY_CONFIG", "").strip()
    if not raw:
        print(
            f"named {section} variant '{variant}' requires EVAL_ADVISORY_CONFIG",
            file=sys.stderr,
        )
        return 2
    try:
        catalog = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"EVAL_ADVISORY_CONFIG is not valid JSON: {error}", file=sys.stderr)
        return 2
    if not isinstance(catalog, dict):
        print("EVAL_ADVISORY_CONFIG must be a JSON object", file=sys.stderr)
        return 2
    entries = catalog.get(section, {})
    value = entries.get(variant) if isinstance(entries, dict) else None
    if not isinstance(value, str) or not value.strip():
        print(
            f"unknown or empty {section} variant '{variant}' in EVAL_ADVISORY_CONFIG",
            file=sys.stderr,
        )
        return 2
    sys.stdout.write(value.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
