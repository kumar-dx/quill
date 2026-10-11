#!/usr/bin/env python3
"""Export Frappe/ERPNext DocType metadata for the Quill POC.

The exporter reads only version-controlled JSON and patch manifests. It never
imports Frappe, opens a site configuration, or connects to MariaDB.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


NON_COLUMN_FIELDS = {
    "Button",
    "Column Break",
    "Fold",
    "Heading",
    "HTML",
    "Image",
    "Section Break",
    "Tab Break",
    "Table",
    "Table MultiSelect",
}

STANDARD_FIELDS = (
    {"name": "name", "column": "name", "type": "Data", "primary_key": True, "null": False},
    {"name": "creation", "column": "creation", "type": "Datetime", "primary_key": False},
    {"name": "modified", "column": "modified", "type": "Datetime", "primary_key": False},
    {
        "name": "modified_by",
        "column": "modified_by",
        "type": "Link",
        "primary_key": False,
        "references": {"model": "User", "table": "tabUser", "column": "name"},
    },
    {
        "name": "owner",
        "column": "owner",
        "type": "Link",
        "primary_key": False,
        "references": {"model": "User", "table": "tabUser", "column": "name"},
    },
    {"name": "docstatus", "column": "docstatus", "type": "Int", "primary_key": False},
    {"name": "idx", "column": "idx", "type": "Int", "primary_key": False},
)

CHILD_FIELDS = (
    {"name": "parent", "column": "parent", "type": "Data", "primary_key": False},
    {"name": "parentfield", "column": "parentfield", "type": "Data", "primary_key": False},
    {"name": "parenttype", "column": "parenttype", "type": "Link", "primary_key": False},
)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None


def git_commit(repo: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (subprocess.SubprocessError, FileNotFoundError):
        return "unknown"


def apps_root(repo: Path) -> Path:
    candidates = (repo / "frappe-bench" / "apps", repo / "apps")
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise ValueError(f"{repo} does not contain frappe-bench/apps or apps")


def iter_doctype_files(root: Path, selected_apps: set[str] | None) -> Iterable[tuple[str, Path]]:
    for app_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        if selected_apps and app_dir.name not in selected_apps:
            continue
        for path in sorted(app_dir.glob("**/doctype/*/*.json")):
            yield app_dir.name, path


def field_metadata(raw: dict[str, Any], source: str, custom: bool = False) -> dict[str, Any] | None:
    name = raw.get("fieldname")
    field_type = raw.get("fieldtype")
    if not isinstance(name, str) or not name or not isinstance(field_type, str) or not field_type:
        return None

    stored = field_type not in NON_COLUMN_FIELDS and not bool(raw.get("is_virtual"))
    field: dict[str, Any] = {
        "name": name,
        "column": name,
        "type": field_type,
        "primary_key": False,
        "stored": stored,
    }
    for source_key, output_key in (
        ("label", "label"),
        ("description", "help_text"),
        ("default", "default"),
        ("options", "choices"),
        ("reqd", "required"),
        ("unique", "unique"),
        ("read_only", "read_only"),
        ("hidden", "hidden"),
        ("search_index", "search_index"),
        ("length", "max_length"),
        ("precision", "precision"),
    ):
        value = raw.get(source_key)
        if value not in (None, "", 0, False):
            field[output_key] = value

    options = raw.get("options")
    if field_type in {"Link", "Table", "Table MultiSelect"} and isinstance(options, str) and options:
        field["references"] = {
            "model": options,
            "table": f"tab{options}",
            "column": "name",
        }
    elif field_type == "Dynamic Link":
        field["dynamic_reference_field"] = options

    if custom:
        field["custom"] = True
    field["source"] = source
    return field


def parse_doctype(app: str, path: Path, root: Path) -> dict[str, Any] | None:
    raw = read_json(path)
    if not isinstance(raw, dict) or raw.get("doctype") != "DocType" or not raw.get("name"):
        return None

    name = str(raw["name"])
    relative = str(path.relative_to(root))
    is_single = bool(raw.get("issingle"))
    is_virtual = bool(raw.get("is_virtual"))
    is_child = bool(raw.get("istable"))
    fields = [dict(field) for field in STANDARD_FIELDS] if not is_single and not is_virtual else []
    if is_child and not is_virtual:
        fields.extend(dict(field) for field in CHILD_FIELDS)
    field_names = {field["name"] for field in fields}
    for value in raw.get("fields", []):
        field = field_metadata(value, relative) if isinstance(value, dict) else None
        if not field or field["name"] in field_names:
            continue
        fields.append(field)
        field_names.add(field["name"])

    indexes: list[dict[str, Any]] = [{"type": "PrimaryKey", "name": "PRIMARY", "fields": ["name"]}]
    for field in fields:
        if field.get("unique"):
            indexes.append({"type": "Unique", "fields": [field["column"]]})
        elif field.get("search_index"):
            indexes.append({"type": "Index", "fields": [field["column"]]})
    for value in raw.get("indexes", []) or []:
        if isinstance(value, list) and value:
            indexes.append({"type": "Index", "fields": value})
        elif isinstance(value, dict):
            indexes.append({"type": "Index", **value})

    return {
        "app": app,
        "module": raw.get("module") or "",
        "name": name,
        "table": f"tab{name}",
        "description": raw.get("description") or "",
        "fields": fields,
        "indexes": indexes if not is_single and not is_virtual else [],
        "constraints": [],
        "source": relative,
        "storage": {
            "engine": raw.get("engine") or "InnoDB",
            "physical_table": not is_single and not is_virtual,
            "single": is_single,
            "virtual": is_virtual,
            "child_table": is_child,
        },
    }


def apply_custom_fields(
    models: list[dict[str, Any]], root: Path, selected_apps: set[str] | None
) -> tuple[int, int, int, list[dict[str, str]]]:
    by_name = {model["name"]: model for model in models}
    added = 0
    already_defined = 0
    invalid = 0
    unresolved: list[dict[str, str]] = []
    for app_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        if selected_apps and app_dir.name not in selected_apps:
            continue
        for path in sorted(app_dir.glob("**/fixtures/custom_field.json")):
            records = read_json(path)
            if not isinstance(records, list):
                continue
            relative = str(path.relative_to(root))
            for record in records:
                if not isinstance(record, dict):
                    continue
                target = record.get("dt")
                model = by_name.get(target)
                field = field_metadata(record, relative, custom=True)
                if not field:
                    invalid += 1
                    continue
                if not model:
                    unresolved.append({"model": str(target or ""), "field": field["name"], "source": relative})
                    continue
                existing = {item["name"] for item in model["fields"]}
                if field["name"] in existing:
                    already_defined += 1
                    continue
                model["fields"].append(field)
                if field.get("unique"):
                    model["indexes"].append({"type": "Unique", "fields": [field["column"]]})
                elif field.get("search_index"):
                    model["indexes"].append({"type": "Index", "fields": [field["column"]]})
                added += 1
    return added, already_defined, invalid, unresolved


def parse_patches(root: Path, selected_apps: set[str] | None) -> list[dict[str, Any]]:
    migrations: list[dict[str, Any]] = []
    for app_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        if selected_apps and app_dir.name not in selected_apps:
            continue
        for path in sorted(app_dir.glob("**/patches.txt")):
            relative = str(path.relative_to(root))
            for line_number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                patch = line.strip()
                if not patch or patch.startswith("#") or patch.startswith("["):
                    continue
                migrations.append(
                    {
                        "app": app_dir.name,
                        "name": patch,
                        "source": relative,
                        "line": line_number,
                    }
                )
    return migrations


def build_catalog(repo: Path, selected_apps: set[str] | None = None) -> dict[str, Any]:
    root = apps_root(repo)
    models_by_name: dict[str, dict[str, Any]] = {}
    for app, path in iter_doctype_files(root, selected_apps):
        model = parse_doctype(app, path, root)
        if not model:
            continue
        existing = models_by_name.get(model["name"])
        if existing:
            existing.setdefault("alternate_sources", []).append(model["source"])
            continue
        models_by_name[model["name"]] = model
    models = list(models_by_name.values())
    models.sort(key=lambda model: (model["table"].lower(), model["app"]))
    (
        custom_field_count,
        existing_custom_field_count,
        invalid_custom_field_count,
        unresolved_custom_fields,
    ) = apply_custom_fields(models, root, selected_apps)
    app_names = sorted({model["app"] for model in models})
    commits = {app: git_commit(root / app) for app in app_names}
    primary_commit = commits.get("drivex") or next((sha for sha in commits.values() if sha != "unknown"), "unknown")

    return {
        "version": {
            "commit_sha": primary_commit,
            "app_commits": commits,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_repository": repo.name,
            "framework": "Frappe / ERPNext",
            "database": "MariaDB",
            "dialect": "mariadb",
            "format": 1,
        },
        "models": models,
        "migrations": parse_patches(root, selected_apps),
        "glossary": {},
        "export_summary": {
            "apps": app_names,
            "custom_fields_merged": custom_field_count,
            "custom_fields_already_defined": existing_custom_field_count,
            "invalid_custom_fields_skipped": invalid_custom_field_count,
            "unresolved_custom_fields": unresolved_custom_fields,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="Path to the ERPX repository or Frappe bench")
    parser.add_argument("--output", type=Path, required=True, help="Output JSON path")
    parser.add_argument(
        "--apps",
        nargs="+",
        help="Optional app directory names to include (default: every app under frappe-bench/apps)",
    )
    args = parser.parse_args()

    repo = args.repo.expanduser().resolve()
    try:
        catalog = build_catalog(repo, set(args.apps) if args.apps else None)
    except ValueError as error:
        parser.error(str(error))
    if not catalog["models"]:
        parser.error("No Frappe DocType JSON files were found")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, indent=2, default=str) + "\n", encoding="utf-8")
    fields = sum(len(model["fields"]) for model in catalog["models"])
    print(
        f"Wrote {len(catalog['models'])} models, {fields} fields, "
        f"{len(catalog['migrations'])} patches, and "
        f"{catalog['export_summary']['custom_fields_merged']} custom fields to {args.output}"
    )


if __name__ == "__main__":
    main()
