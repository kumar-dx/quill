#!/usr/bin/env python3
"""Export MetaX Django models and migration summaries for the Quill POC.

The exporter intentionally uses Python's AST instead of importing Django. This
keeps generation read-only and avoids needing database credentials or executing
application code from the source repository.
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


FIELD_TYPES = {
    "AutoField",
    "BigAutoField",
    "BigIntegerField",
    "BinaryField",
    "BooleanField",
    "CharField",
    "DateField",
    "DateTimeField",
    "DecimalField",
    "DurationField",
    "EmailField",
    "FileField",
    "FloatField",
    "ForeignKey",
    "ImageField",
    "IntegerField",
    "JSONField",
    "ManyToManyField",
    "OneToOneField",
    "PositiveIntegerField",
    "PositiveSmallIntegerField",
    "SmallIntegerField",
    "TextField",
    "TimeField",
    "URLField",
    "UUIDField",
    "ArrayField",
}

RELATION_TYPES = {"ForeignKey", "OneToOneField", "ManyToManyField"}


@dataclass
class SourceModel:
    app: str
    name: str
    table: str
    description: str
    fields: list[dict[str, Any]]
    indexes: list[dict[str, Any]]
    constraints: list[dict[str, Any]]
    source: str


def dotted_name(node: ast.AST | None) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return ""


def literal(node: ast.AST | None) -> Any:
    if node is None:
        return None
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        name = dotted_name(node)
        if name:
            return name
        try:
            return ast.unparse(node)
        except Exception:
            return None


def call_name(node: ast.AST | None) -> str:
    if not isinstance(node, ast.Call):
        return ""
    return dotted_name(node.func).split(".")[-1]


def keyword_map(call: ast.Call) -> dict[str, Any]:
    return {item.arg: literal(item.value) for item in call.keywords if item.arg}


def string_description(class_node: ast.ClassDef) -> str:
    value = ast.get_docstring(class_node, clean=True) or ""
    return " ".join(value.split())[:500]


def meta_options(class_node: ast.ClassDef) -> dict[str, ast.AST]:
    for child in class_node.body:
        if isinstance(child, ast.ClassDef) and child.name == "Meta":
            return {
                statement.targets[0].id: statement.value
                for statement in child.body
                if isinstance(statement, ast.Assign)
                and len(statement.targets) == 1
                and isinstance(statement.targets[0], ast.Name)
            }
    return {}


def parse_index_or_constraint(node: ast.AST) -> dict[str, Any] | None:
    if not isinstance(node, ast.Call):
        return None
    kind = call_name(node)
    values = keyword_map(node)
    result: dict[str, Any] = {"type": kind}
    for key in ("name", "fields", "condition", "include"):
        if key in values and values[key] is not None:
            result[key] = values[key]
    return result


def parse_meta_collection(node: ast.AST | None) -> list[dict[str, Any]]:
    if not isinstance(node, (ast.List, ast.Tuple)):
        return []
    return [item for child in node.elts if (item := parse_index_or_constraint(child))]


def parse_field(name: str, call: ast.Call) -> dict[str, Any]:
    field_type = call_name(call)
    options = keyword_map(call)
    column = options.get("db_column") or f"{name}_id" if field_type in RELATION_TYPES else options.get("db_column") or name
    result: dict[str, Any] = {
        "name": name,
        "column": column,
        "type": field_type,
        "primary_key": bool(options.get("primary_key", False)),
    }
    for key in (
        "null",
        "blank",
        "unique",
        "default",
        "max_length",
        "related_name",
        "choices",
        "help_text",
        "on_delete",
    ):
        if key in options and options[key] is not None:
            result[key] = options[key]

    if field_type in RELATION_TYPES and call.args:
        target = dotted_name(call.args[0]) or str(literal(call.args[0]) or "")
        result["references"] = {"model": target.split(".")[-1]}
    return result


def is_model_class(node: ast.ClassDef) -> bool:
    bases = {dotted_name(base).split(".")[-1] for base in node.bases}
    return bool(bases & {"Model", "DateTimeStamp"})


def parse_model_file(path: Path, repo: Path) -> list[SourceModel]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (SyntaxError, UnicodeDecodeError):
        return []

    relative = path.relative_to(repo)
    app = relative.parts[1] if relative.parts[0] == "central_db" else relative.parts[0]
    models: list[SourceModel] = []

    for node in tree.body:
        if not isinstance(node, ast.ClassDef) or not is_model_class(node):
            continue
        meta = meta_options(node)
        raw_table = literal(meta.get("db_table"))
        table = raw_table if isinstance(raw_table, str) else f"{app}_{node.name.lower()}"
        if table and '\".\"' in table:
            table = table.replace('\".\"', ".")

        fields: list[dict[str, Any]] = []
        for statement in node.body:
            if not isinstance(statement, ast.Assign) or len(statement.targets) != 1:
                continue
            target = statement.targets[0]
            if not isinstance(target, ast.Name) or not isinstance(statement.value, ast.Call):
                continue
            if call_name(statement.value) in FIELD_TYPES:
                fields.append(parse_field(target.id, statement.value))

        models.append(
            SourceModel(
                app=app,
                name=node.name,
                table=table,
                description=string_description(node),
                fields=fields,
                indexes=parse_meta_collection(meta.get("indexes")),
                constraints=parse_meta_collection(meta.get("constraints")),
                source=str(relative),
            )
        )
    return models


def resolve_relationship_tables(models: list[SourceModel]) -> None:
    by_class: dict[str, list[SourceModel]] = {}
    for model in models:
        by_class.setdefault(model.name, []).append(model)

    for model in models:
        for field in model.fields:
            reference = field.get("references")
            if not reference:
                continue
            target_name = reference.get("model", "").strip('"\'')
            if "." in target_name:
                target_name = target_name.split(".")[-1]
            candidates = by_class.get(target_name, [])
            if len(candidates) == 1:
                reference["table"] = candidates[0].table
            reference["column"] = "id"


def operation_summary(call: ast.Call) -> dict[str, Any]:
    kind = call_name(call)
    values = keyword_map(call)
    result: dict[str, Any] = {"type": kind}
    for key in ("model_name", "name", "old_name", "new_name"):
        if key in values and values[key] is not None:
            result[key] = values[key]
    field_node = next((item.value for item in call.keywords if item.arg == "field"), None)
    if isinstance(field_node, ast.Call):
        result["field_type"] = call_name(field_node)
    return result


def parse_migration(path: Path, repo: Path) -> dict[str, Any] | None:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (SyntaxError, UnicodeDecodeError):
        return None
    relative = path.relative_to(repo)
    app = relative.parts[1]
    migration_class = next(
        (node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Migration"),
        None,
    )
    if migration_class is None:
        return None

    assignments = {
        statement.targets[0].id: statement.value
        for statement in migration_class.body
        if isinstance(statement, ast.Assign)
        and len(statement.targets) == 1
        and isinstance(statement.targets[0], ast.Name)
    }
    dependencies = literal(assignments.get("dependencies")) or []
    operations_node = assignments.get("operations")
    operations = []
    if isinstance(operations_node, (ast.List, ast.Tuple)):
        operations = [operation_summary(item) for item in operations_node.elts if isinstance(item, ast.Call)]

    return {
        "app": app,
        "name": path.stem,
        "dependencies": dependencies,
        "operations": operations,
        "source": str(relative),
    }


def git_commit(repo: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (subprocess.SubprocessError, FileNotFoundError):
        return "unknown"


def iter_model_files(repo: Path) -> Iterable[Path]:
    yield from sorted((repo / "central_db").glob("*/models/**/*.py"))


def iter_migration_files(repo: Path) -> Iterable[Path]:
    for path in sorted((repo / "central_db").glob("*/migrations/*.py")):
        if path.name != "__init__.py":
            yield path


def build_catalog(repo: Path) -> dict[str, Any]:
    models = [model for path in iter_model_files(repo) for model in parse_model_file(path, repo)]
    resolve_relationship_tables(models)
    migrations = [item for path in iter_migration_files(repo) if (item := parse_migration(path, repo))]

    return {
        "version": {
            "commit_sha": git_commit(repo),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_repository": repo.name,
            "format": 1,
        },
        "models": [model.__dict__ for model in models],
        "migrations": migrations,
        "glossary": {
            "quality rating": [
                "inspections.quality_rating_id",
                "inspections.quality_score",
                "inspections.rating",
                "dtc_quality_checks.qc_rating",
            ],
            "procured date": ["procured_vehicles.procured_date"],
            "inspection owner": ["inspections.inspected_by_id", "users.email"],
            "vehicle registration": ["vehicles.registration_number"],
            "nqs": ["inspections.quality_score", "inspections.quality_rating_id"],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="Path to metax-database")
    parser.add_argument("--output", type=Path, required=True, help="Output JSON path")
    args = parser.parse_args()

    repo = args.repo.expanduser().resolve()
    if not (repo / "central_db" / "manage.py").exists():
        parser.error(f"{repo} does not look like the MetaX repository")

    catalog = build_catalog(repo)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, indent=2, default=str) + "\n", encoding="utf-8")
    fields = sum(len(model["fields"]) for model in catalog["models"])
    print(
        f"Wrote {len(catalog['models'])} models, {fields} fields, and "
        f"{len(catalog['migrations'])} migrations to {args.output}"
    )


if __name__ == "__main__":
    main()
