"""Counts recorded carton identifiers without allocating quantities to cartons."""
import re
import unicodedata
from functools import lru_cache

MAX_RANGE = 10_000


@lru_cache(maxsize=256)
def parse_boxes(value):
    text = unicodedata.normalize("NFKC", value or "").strip()
    if not text:
        return frozenset(), ("Missing box number",)
    boxes = set()
    issues = []
    for token in re.split(r"[,;\n\r]+", text):
        token = token.strip()
        if not token:
            continue
        compact = re.sub(r"\s+", "", token).upper().replace("–", "-").replace("—", "-")
        match = re.fullmatch(r"([A-Z]*)([0-9]{1,9})(?:-([A-Z]*)([0-9]{1,9}))?", compact)
        if not match:
            issues.append("Unrecognised box label: " + token)
            continue
        prefix, first, end_prefix, last = match.groups()
        start = int(first)
        end = int(last) if last else start
        if (end_prefix and end_prefix != prefix) or end < start or end - start + 1 > MAX_RANGE:
            issues.append("Invalid or excessive box range: " + token)
            continue
        if len(boxes) + end - start + 1 > MAX_RANGE:
            issues.append("Too many box identifiers in one label")
            break
        boxes.update(prefix + str(number) for number in range(start, end + 1))
    if not boxes and not issues:
        issues.append("No box identifiers found")
    return frozenset(boxes), tuple(issues)


def count_boxes(labels, declared=None):
    boxes = set()
    issues = set()
    any_rows = False
    for label in labels:
        any_rows = True
        parsed, warnings = parse_boxes(label)
        boxes.update(parsed)
        issues.update(warnings)
    if not any_rows:
        issues.add("No product rows recorded")
    complete = not issues
    return {
        "count": len(boxes),
        "complete": complete,
        "issues": sorted(issues),
        "difference": len(boxes) - declared if complete and declared is not None else None,
    }
