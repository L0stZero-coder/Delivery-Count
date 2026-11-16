import argparse
import io
import json
import re
import sqlite3
import sys
import unicodedata
import zipfile
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import xlrd
from defusedxml.ElementTree import fromstring
from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries

from backup import BACKUPS
from box_counts import count_boxes

ROOT = Path(__file__).resolve().parent
LIMIT = 50 * 1024 * 1024
HEADERS = ("product name", "product model", "qty", "colour")
OPTIONAL_HEADERS = ("box number", "barcode")
IGNORED_HEADERS = {"product image", "w price", "price", "retail price", "wholesale price"}
EXTENSIONS = (".xlsx", ".xls", ".xl", ".ods")
ODS_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}


def label(value):
    return " ".join(unicodedata.normalize("NFKC", str(value if value is not None else "")).split())


def key(value):
    return label(value).casefold()


def normalize_model(value):
    model = label(value)
    model = re.sub(r"\b(?:ip|iphone)(?=\b|\d)", "iPhone", model, flags=re.I)
    model = re.sub(r"\b(?:pad|ipad)\b", "iPad", model, flags=re.I)
    model = re.sub(r"^iPhone\s*", "iPhone ", model)
    if re.match(r"^\d+(?:\.0+)?(?=\b|[eEcC](?:\b|/))", model):
        model = "iPhone " + model
    if model.startswith("iPhone "):
        model = re.sub(r"\b(\d+)\.0+\b", r"\1", model)
    model = re.sub(r"^(?:samsung\s+galaxy|samsung|galaxy|sam)(?=\b|[a-z]?\d)\s*",
                   "Samsung ", model, flags=re.I)
    if re.match(r"^s\s*\d", model, flags=re.I):
        model = "Samsung " + model
    if model.startswith("Samsung "):
        model = re.sub(r"\bs\s*(?=\d)", "S", model, flags=re.I)
    return model.strip()


def normalize_existing_models(db):
    for product_id, name_key, model, colour_key in db.execute(
        "SELECT id, name_key, model, colour_key FROM products ORDER BY id"
    ).fetchall():
        normalized = normalize_model(model)
        target = db.execute(
            "SELECT id FROM products WHERE name_key=? AND model_key=? AND colour_key=?",
            (name_key, key(normalized), colour_key),
        ).fetchone()
        if target and target[0] != product_id:
            db.execute("UPDATE delivery_lines SET product=? WHERE product=?", (target[0], product_id))
            db.execute("UPDATE delivery_activity_lines SET product=? WHERE product=?", (target[0], product_id))
            db.execute("DELETE FROM products WHERE id=?", (product_id,))
        else:
            db.execute("UPDATE products SET model=?, model_key=? WHERE id=?",
                       (normalized, key(normalized), product_id))


def positive_int(value, field):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]+(?:\.0+)?", str(value).strip()):
        raise ValueError(f"{field} must be a whole number greater than zero.")
    number = int(str(value).strip().split(".")[0])
    if not 0 < number <= 2_147_483_647:
        raise ValueError(f"{field} must be between 1 and 2,147,483,647.")
    return number


def sheet_one(names):
    for name in names:
        if key(name).replace(" ", "") == "sheet1":
            return name
    raise ValueError('The workbook needs a worksheet named "Sheet 1" or "Sheet1".')


def spreadsheet_text(value):
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return "" if value is None else str(value).strip()


def merged_rows(rows, ranges):
    spans = {}
    for start, end, column in ranges:
        if end > start:
            spans.setdefault(start, []).append((end, column))
    active = {}
    for index, original in enumerate(rows):
        row = list(original)
        active = {column: span for column, span in active.items() if span[0] > index}
        for column, (_, value) in active.items():
            if column >= len(row):
                row.extend([None] * (column + 1 - len(row)))
            row[column] = value
        for end, column in spans.get(index, ()):
            if column < len(row):
                active[column] = (end, row[column])
        yield row


def read_rows(rows):
    rows = iter(rows)
    for row in rows:
        if any(label(cell) for cell in row):
            labels = [spreadsheet_text(cell) for cell in row]
            headers = ["product model" if key(cell) == "model" else key(cell) for cell in labels]
            break
    else:
        raise ValueError("Sheet 1 is empty.")
    if any(headers.count(header) != 1 for header in HEADERS):
        raise ValueError("Sheet 1 needs one column each for Product Name, Product Model, QTY and Colour.")
    indexes = [headers.index(header) for header in HEADERS]
    optional = {header: headers.index(header) for header in OPTIONAL_HEADERS if header in headers}
    extras = [(i, labels[i]) for i, header in enumerate(headers)
              if header and header not in (*HEADERS, *OPTIONAL_HEADERS) and header not in IGNORED_HEADERS]
    items = {}
    for row_number, row in enumerate(rows, 2):
        if row_number > 50_001:
            raise ValueError("Use at most 50,000 data rows per delivery.")
        name, model, qty, colour = [row[i] if i < len(row) else None for i in indexes]
        if not any(label(cell) for cell in (name, model, qty, colour)):
            continue
        names = (label(name), normalize_model(model), label(colour))
        if not all(names):
            raise ValueError(f"Data row {row_number - 1} needs a product name, model and colour.")
        quantity = positive_int(qty, f"QTY on data row {row_number - 1}")
        def value_at(index):
            return spreadsheet_text(row[index]) if 0 <= index < len(row) else ""

        box, barcode = (value_at(optional.get(header, -1)) for header in OPTIONAL_HEADERS)
        details = json.dumps({heading: value_at(index) for index, heading in extras})
        identity = (*map(key, names), box, barcode, details)
        previous = items.get(identity)
        items[identity] = (*previous[:3], previous[3] + quantity) if previous else (*names, quantity)
    if not items:
        raise ValueError("Sheet 1 contains no delivery items.")
    return items


def ods_tag(namespace, name):
    return f"{{{ODS_NS[namespace]}}}{name}"


def ods_rows(content):
    root = fromstring(content)
    sheets = {sheet.get(ods_tag("table", "name"), ""): sheet
              for sheet in root.findall("office:body/office:spreadsheet/table:table", ODS_NS)}
    sheet = sheets[sheet_one(sheets)]
    active = {}
    for row in sheet.iter(ods_tag("table", "table-row")):
        values = []
        spans = {}
        for cell in row:
            if cell.tag not in (ods_tag("table", "table-cell"), ods_tag("table", "covered-table-cell")):
                continue
            value = cell.get(ods_tag("office", "value"))
            if value is None:
                value = cell.get(ods_tag("office", "string-value"))
            if value is None:
                value = " ".join("".join(p.itertext()) for p in cell.findall("text:p", ODS_NS))
            copies = int(cell.get(ods_tag("table", "number-columns-repeated"), "1"))
            copies = min(copies, 16_384 - len(values))
            span = int(cell.get(ods_tag("table", "number-rows-spanned"), "1"))
            if span > 1:
                for column in range(len(values), len(values) + copies):
                    spans[column] = (span, value)
            values.extend([value] * copies)
            if len(values) == 16_384:
                break
        repeats = int(row.get(ods_tag("table", "number-rows-repeated"), "1"))
        if not any(values) and not active and not spans:
            yield []
            continue
        for _ in range(min(repeats, 50_002)):
            active.update(spans)
            expanded = values.copy()
            for column, (_, value) in active.items():
                if column < len(expanded):
                    expanded[column] = value
            yield expanded
            active = {column: (remaining - 1, value) for column, (remaining, value) in active.items()
                      if remaining > 1}


def read_workbook(data, extension):
    try:
        if extension == ".xl":
            extension = ".xlsx" if zipfile.is_zipfile(io.BytesIO(data)) else ".xls"
        if extension == ".xls":
            workbook = xlrd.open_workbook(file_contents=data, on_demand=True, formatting_info=True)
            try:
                sheet = workbook.sheet_by_name(sheet_one(workbook.sheet_names()))
                rows = (sheet.row_values(i) for i in range(sheet.nrows))
                spans = ((start, end, col) for start, end, col, _ in sheet.merged_cells)
                return read_rows(merged_rows(rows, spans))
            finally:
                workbook.release_resources()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if sum(entry.file_size for entry in archive.infolist()) > 80 * 1024 * 1024:
                raise ValueError("The workbook is too large once expanded.")
            if extension == ".ods":
                return read_rows(ods_rows(archive.read("content.xml")))
            workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
            try:
                sheet = workbook[sheet_one(workbook.sheetnames)]
                sheet.reset_dimensions()
                # Read-only worksheets stream cells but do not expose merged ranges.
                root = fromstring(archive.read(sheet._worksheet_path))
                spans = []
                for cell in root.findall("./{*}mergeCells/{*}mergeCell"):
                    col, start, _, end = range_boundaries(cell.attrib["ref"])
                    spans.append((start - 1, end, col - 1))
                return read_rows(merged_rows(sheet.iter_rows(values_only=True), spans))
            finally:
                workbook.close()
    except ValueError:
        raise
    except Exception as error:
        raise ValueError("Could not read Sheet 1. Check that this is a valid Excel workbook.") from error


def model_sort_key(row):
    return tuple(
        (0, int(part)) if part.isdecimal() else (1, part)
        for part in re.split(r"(\d+)", key(row["model"])) if part
    )


def grouped_history(rows):
    groups = {}
    for row in rows:
        identity = (row["id"], row["product_id"])
        if identity not in groups:
            groups[identity] = {
                field: row[field] for field in ("id", "product_id", "arrival", "status", "boxes", "name", "model", "colour")
            } | {"qty": 0, "box_number": {}, "barcode": {}, "details": {}, "recorded_box_labels": []}
        group = groups[identity]
        group["qty"] += row["qty"]
        box = row["box_number"]
        group["recorded_box_labels"].append(box)
        if box:
            group["box_number"][box] = group["box_number"].get(box, 0) + row["qty"]
        if row["barcode"]:
            group["barcode"][row["barcode"]] = None
        for heading, value in json.loads(row["details"]).items():
            values = group["details"].setdefault(heading, {})
            if value:
                values[value] = None

    for group in groups.values():
        group["product_box_count"] = count_boxes(group.pop("recorded_box_labels"))
        group["box_quantities"] = list(group["box_number"].items())
        for field in ("box_number", "barcode"):
            group[field] = ", ".join(group[field])
        group["details"] = {heading: ", ".join(values) for heading, values in group["details"].items()}
    return sorted(groups.values(), key=model_sort_key)


def delivery_box_numbers(db, delivery):
    return [row[0] for row in db.execute(
        "SELECT DISTINCT box_number FROM delivery_lines WHERE delivery=? AND box_number<>'' ORDER BY rowid",
        (delivery,))]


def delivery_box_count(db, delivery, declared):
    labels = (row[0] for row in db.execute(
        "SELECT box_number FROM delivery_lines WHERE delivery=?", (delivery,)))
    return count_boxes(labels, declared)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if sys.stderr is not None:
            super().log_message(format, *args)

    def reply(self, status, content, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def json(self, status, value):
        self.reply(status, json.dumps(value).encode(), "application/json")

    def do_GET(self):
        url = urlsplit(self.path)
        assets = {"/delivery": ("delivery.html", "text/html"), "/delivery.js": ("delivery.js", "text/javascript"), "/report.js": ("report.js", "text/javascript"), "/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
                  "/style.css": ("style.css", "text/css"),
                  "/date-range.js": ("date-range.js", "text/javascript"),
                  "/edit": ("edit.html", "text/html"), "/edit.js": ("edit.js", "text/javascript")}
        if url.path in assets:
            filename, mime = assets[url.path]
            self.reply(200, (ROOT / filename).read_bytes(), mime + "; charset=utf-8")
        elif url.path == "/api/deliveries":
            with sqlite3.connect(self.server.database) as db:
                db.row_factory = sqlite3.Row
                db.execute("BEGIN")
                deliveries = []
                for row in db.execute("SELECT * FROM deliveries ORDER BY arrival DESC, id DESC"):
                    deliveries.append(dict(row) | {"box_numbers": delivery_box_numbers(db, row["id"]),
                        "box_count": delivery_box_count(db, row["id"], row["boxes"])})
            self.json(200, {"deliveries": deliveries, "backup_path": str(BACKUPS)})
        elif url.path == "/api/activity":
            with sqlite3.connect(self.server.database) as db:
                db.row_factory = sqlite3.Row
                activity = db.execute("""
                    SELECT a.*, (a.undone_at IS NULL AND a.id = (
                        SELECT MAX(id) FROM delivery_activity
                        WHERE delivery=a.delivery AND undone_at IS NULL
                    )) AS can_undo
                    FROM delivery_activity a ORDER BY a.id DESC
                """).fetchall()
            self.json(200, {"activity": [dict(row) for row in activity]})
        elif url.path == "/api/history":
            filters = parse_qs(url.query)
            terms = [key(filters.get(field, [""])[0]) for field in ("name", "colour")]
            with sqlite3.connect(self.server.database) as db:
                db.row_factory = sqlite3.Row
                db.execute("BEGIN")
                rows = db.execute("""
                    SELECT d.id, d.arrival, d.status, d.boxes, p.id AS product_id,
                           p.name_key || ' ' || p.model_key || ' ' || p.colour_key AS search_text,
                           p.name, p.model, p.colour, i.qty, i.box_number, i.barcode, i.details
                    FROM delivery_lines i JOIN deliveries d ON d.id = i.delivery
                    JOIN products p ON p.id = i.product
                    WHERE instr(p.name_key, ?) > 0 AND instr(p.colour_key, ?) > 0
                    ORDER BY d.arrival DESC, d.id DESC, p.name_key, p.model_key, p.colour_key, i.rowid
                """, terms).fetchall()
                delivery_counts = {
                    row["id"]: delivery_box_count(db, row["id"], row["boxes"])
                    for row in db.execute("SELECT id, boxes FROM deliveries")
                }
            start = filters.get("date_from", [""])[0]
            end = filters.get("date_to", [""])[0]
            try:
                for boundary in (start, end):
                    if boundary and (not re.fullmatch(r"\d{4}-\d{2}-\d{2}", boundary)
                                     or date.fromisoformat(boundary).isoformat() != boundary):
                        raise ValueError()
                if start and end and start > end:
                    raise ValueError()
            except ValueError:
                self.json(400, {"error": "Choose valid arrival dates with From on or before To."})
                return
            rows = [row for row in rows if (not start or row["arrival"] >= start)
                    and (not end or row["arrival"] <= end)]
            status = filters.get("status", [""])[0]
            if status:
                rows = [row for row in rows if row["status"] == status]
            delivery_id = filters.get("delivery", [""])[0]
            if delivery_id:
                rows = [row for row in rows if str(row["id"]) == delivery_id]
            boxes = filters.get("boxes", [""])[0].strip()
            if boxes:
                rows = [row for row in rows if str(row["boxes"]) == boxes]
            query = key(filters.get("q", [""])[0]).split()
            if query:
                rows = [row for row in rows if all(
                    term in row["search_text"] for term in query
                )]
            rows = grouped_history(rows)
            for row in rows:
                row["delivery_box_count"] = delivery_counts[row["id"]]
            self.json(200, {"rows": rows, "total": sum(row["qty"] for row in rows)})
        else:
            self.json(404, {"error": "Page not found."})

    def edit_delivery(self, delivery_id):
        if self.headers.get("Content-Type") != "application/json":
            self.json(415, {"error": "Expected delivery details as JSON."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("Invalid delivery details.")
            values = json.loads(self.rfile.read(length))
            if not isinstance(values, dict):
                raise ValueError("Invalid delivery details.")
            arrival = str(values.get("arrival", ""))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", arrival):
                raise ValueError("Enter a valid arrival date.")
            date.fromisoformat(arrival)
            boxes = positive_int(values.get("boxes", ""), "Delivery boxes")
            previous_arrival = str(values.get("previous_arrival", ""))
            previous_boxes = positive_int(values.get("previous_boxes", ""), "Previous delivery boxes")
            with sqlite3.connect(self.server.database) as db:
                db.execute("BEGIN IMMEDIATE")
                previous = db.execute(
                    "SELECT status FROM deliveries WHERE id=? AND arrival=? AND boxes=?",
                    (delivery_id, previous_arrival, previous_boxes),
                ).fetchone()
                if previous is None:
                    self.json(409, {"error": "This delivery has changed. Reload the page before editing it."})
                    return
                old_status = previous[0]
                status = old_status
                if arrival != previous_arrival and arrival > date.today().isoformat():
                    status = "expected"
                if (arrival, boxes) != (previous_arrival, previous_boxes):
                    db.execute("UPDATE deliveries SET arrival=?, boxes=?, status=? WHERE id=?",
                               (arrival, boxes, status, delivery_id))
                    db.execute("""
                        INSERT INTO delivery_activity(delivery, kind, old_arrival, old_boxes,
                            new_arrival, new_boxes, old_status, new_status)
                        VALUES (?, 'edit', ?, ?, ?, ?, ?, ?)
                    """, (delivery_id, previous_arrival, previous_boxes, arrival, boxes, old_status, status))
                summary = delivery_box_count(db, delivery_id, boxes)
            self.json(200, {"arrival": arrival, "boxes": boxes, "status": status, "box_count": summary})
        except (ValueError, UnicodeDecodeError):
            self.json(400, {"error": "Enter a valid arrival date and a positive whole-number box count."})
        except sqlite3.Error:
            self.json(503, {"error": "Could not save the delivery. Please try again."})

    def undo_activity(self, activity_id):
        if self.headers.get("Content-Type") != "application/json":
            self.json(415, {"error": "Expected a JSON request."})
            return
        try:
            if self.headers.get("Content-Length") != "2" or self.rfile.read(2) != b"{}":
                self.json(400, {"error": "Invalid undo request."})
                return
            with sqlite3.connect(self.server.database) as db:
                db.row_factory = sqlite3.Row
                db.execute("BEGIN IMMEDIATE")
                activity = db.execute("""
                    SELECT * FROM delivery_activity WHERE id=? AND undone_at IS NULL
                    AND id=(SELECT MAX(id) FROM delivery_activity
                            WHERE delivery=(SELECT delivery FROM delivery_activity WHERE id=?)
                            AND undone_at IS NULL)
                """, (activity_id, activity_id)).fetchone()
                if activity is None:
                    self.json(409, {"error": "Only the latest change for a delivery can be undone. Refresh the activity log."})
                    return
                delivery = activity["delivery"]
                if activity["kind"] == "status":
                    db.execute("UPDATE deliveries SET arrival=?, status=? WHERE id=?",
                               (activity["old_arrival"], activity["old_status"], delivery))
                elif activity["kind"] == "edit":
                    db.execute("UPDATE deliveries SET arrival=?, boxes=?, status=COALESCE(?, status) WHERE id=?",
                               (activity["old_arrival"], activity["old_boxes"], activity["old_status"], delivery))
                else:
                    db.execute("DELETE FROM delivery_lines WHERE delivery=?", (delivery,))
                    db.execute("""
                        INSERT INTO delivery_lines(delivery, product, qty, box_number, barcode, details)
                        SELECT ?, product, qty, box_number, barcode, details FROM delivery_activity_lines
                        WHERE activity=? ORDER BY rowid
                    """, (delivery, activity_id))
                    db.execute("UPDATE deliveries SET revision=revision+1 WHERE id=?", (delivery,))
                db.execute("UPDATE delivery_activity SET undone_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                           (activity_id,))
                record = dict(db.execute("SELECT * FROM deliveries WHERE id=?", (delivery,)).fetchone())
                record["box_numbers"] = delivery_box_numbers(db, delivery)
                record["box_count"] = delivery_box_count(db, delivery, record["boxes"])
            self.json(200, {"delivery": record, "kind": activity["kind"]})
        except sqlite3.Error:
            self.log_error("Delivery undo failed")
            self.json(503, {"error": "Could not undo this change. Please try again."})

    def change_delivery_status(self, delivery_id):
        if self.headers.get("Content-Type") != "application/json":
            self.json(415, {"error": "Expected JSON."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError()
            values = json.loads(self.rfile.read(length))
            if not isinstance(values, dict) or values.get("status") not in ("arrived", "delayed"):
                raise ValueError()
            status = values["status"]
            arrival = str(values.get("arrival", ""))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", arrival):
                raise ValueError()
            parsed = date.fromisoformat(arrival)
            if (status == "delayed" and parsed <= date.today()) or (status == "arrived" and parsed > date.today()):
                raise ValueError()
            with sqlite3.connect(self.server.database) as db:
                db.row_factory = sqlite3.Row
                db.execute("BEGIN IMMEDIATE")
                previous = db.execute("SELECT * FROM deliveries WHERE id=?", (delivery_id,)).fetchone()
                if previous is None or previous["status"] == "arrived" or (
                    previous["status"], previous["arrival"]
                ) != (values.get("previous_status"), values.get("previous_arrival")):
                    self.json(409, {"error": "This delivery has changed. Close this window and refresh the schedule."})
                    return
                db.execute("UPDATE deliveries SET arrival=?, status=? WHERE id=?", (arrival, status, delivery_id))
                db.execute("""
                    INSERT INTO delivery_activity(delivery, kind, old_arrival, new_arrival,
                        old_status, new_status)
                    VALUES (?, 'status', ?, ?, ?, ?)
                """, (delivery_id, previous["arrival"], arrival, previous["status"], status))
            self.json(200, {"status": status, "arrival": arrival})
        except (ValueError, UnicodeDecodeError):
            self.json(400, {"error": "Choose a valid date. Delayed deliveries need a future expected date."})
        except sqlite3.Error:
            self.json(503, {"error": "Could not update delivery status. Try again."})

    def do_POST(self):
        url = urlsplit(self.path)
        undo = re.fullmatch(r"/api/activity/(\d+)/undo", url.path)
        if undo:
            self.undo_activity(int(undo[1]))
            return
        status_change = re.fullmatch(r"/api/deliveries/(\d+)/status", url.path)
        if status_change:
            self.change_delivery_status(int(status_change[1]))
            return
        edit = re.fullmatch(r"/api/deliveries/(\d+)/edit", url.path)
        if edit:
            self.edit_delivery(int(edit[1]))
            return
        replacement = re.fullmatch(r"/api/deliveries/(\d+)/replace", url.path)
        if url.path != "/api/deliveries" and not replacement:
            self.json(404, {"error": "Page not found."})
            return
        if self.headers.get("Content-Type") != "application/octet-stream":
            self.json(415, {"error": "Upload an Excel workbook from the delivery form."})
            return
        try:
            options = parse_qs(url.query)
            if not replacement:
                arrival = options.get("arrival", [""])[0]
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", arrival):
                    raise ValueError("Enter the delivery arrival date.")
                try:
                    date.fromisoformat(arrival)
                except ValueError:
                    raise ValueError("Enter a valid delivery arrival date.") from None
                boxes = positive_int(options.get("boxes", [""])[0], "Boxes")
            extension = options.get("extension", [""])[0].lower()
            if extension not in EXTENSIONS:
                raise ValueError("Choose an .xlsx, .xls, .xl or .ods workbook.")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= LIMIT:
                raise ValueError("Choose a non-empty workbook up to 50 MB.")
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("The workbook upload was incomplete.")
            items = read_workbook(data, extension)
            with sqlite3.connect(self.server.database) as db:
                if replacement:
                    delivery = int(replacement[1])
                    revision = int(options.get("revision", ["-1"])[0])
                    updated = db.execute(
                        "UPDATE deliveries SET revision=revision+1 WHERE id=? AND revision=?",
                        (delivery, revision),
                    ).rowcount
                    if not updated:
                        self.json(409, {"error": "This delivery has changed or is unavailable. Reload before re-uploading."})
                        return
                    activity = db.execute("""
                        INSERT INTO delivery_activity(delivery, kind, old_qty, new_qty)
                        VALUES (?, 'replace', (SELECT COALESCE(SUM(qty), 0) FROM delivery_lines WHERE delivery=?), ?)
                    """, (delivery, delivery, sum(item[3] for item in items.values()))).lastrowid
                    db.execute("""
                        INSERT INTO delivery_activity_lines(activity, product, qty, box_number, barcode, details)
                        SELECT ?, product, qty, box_number, barcode, details FROM delivery_lines
                        WHERE delivery=? ORDER BY rowid
                    """, (activity, delivery))
                    db.execute("DELETE FROM delivery_lines WHERE delivery=?", (delivery,))
                else:
                    delivery = db.execute("INSERT INTO deliveries(arrival, boxes, status) VALUES (?, ?, ?)",
                                          (arrival, boxes, "arrived" if arrival <= date.today().isoformat() else "expected")).lastrowid
                for identity, (name, model, colour, qty) in items.items():
                    *product, box, barcode, details = identity
                    db.execute("""
                        INSERT INTO products(name_key, model_key, colour_key, name, model, colour)
                        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name_key, model_key, colour_key) DO NOTHING
                    """, (*product, name, model, colour))
                    db.execute("""
                        INSERT INTO delivery_lines(delivery, product, qty, box_number, barcode, details)
                        SELECT ?, id, ?, ?, ?, ? FROM products WHERE name_key=? AND model_key=? AND colour_key=?
                    """, (delivery, qty, box, barcode, details, *product))
            result = {"items": len(items), "qty": sum(item[3] for item in items.values())}
            if replacement:
                with sqlite3.connect(self.server.database) as db:
                    declared = db.execute("SELECT boxes FROM deliveries WHERE id=?", (delivery,)).fetchone()[0]
                    result["box_count"] = delivery_box_count(db, delivery, declared)
                result.update(revision=revision + 1, box_numbers=list(dict.fromkeys(
                    identity[3] for identity in items if identity[3])))
            self.json(200 if replacement else 201, result)
        except ValueError as error:
            self.json(400, {"error": str(error)})
        except sqlite3.Error:
            self.log_error("Delivery database write failed")
            self.json(503, {"error": "Could not save the delivery. Please try again."})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--database", type=Path, default=ROOT / "data" / "deliveries.sqlite3")
    args = parser.parse_args()
    args.database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(args.database) as db:
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS deliveries (
                id INTEGER PRIMARY KEY, arrival TEXT NOT NULL, boxes INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY, name_key TEXT NOT NULL, model_key TEXT NOT NULL,
                colour_key TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL,
                colour TEXT NOT NULL, UNIQUE(name_key, model_key, colour_key)
            );
            CREATE TABLE IF NOT EXISTS delivery_lines (
                delivery INTEGER NOT NULL REFERENCES deliveries(id),
                product INTEGER NOT NULL REFERENCES products(id),
                qty INTEGER NOT NULL, box_number TEXT NOT NULL DEFAULT '',
                barcode TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS delivery_activity (
                id INTEGER PRIMARY KEY, delivery INTEGER NOT NULL REFERENCES deliveries(id),
                kind TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                undone_at TEXT, old_arrival TEXT, new_arrival TEXT, old_boxes INTEGER, new_boxes INTEGER,
                old_qty INTEGER, new_qty INTEGER
            );
            CREATE INDEX IF NOT EXISTS delivery_activity_latest ON delivery_activity(delivery, id)
                WHERE undone_at IS NULL;
            CREATE TABLE IF NOT EXISTS delivery_activity_lines (
                activity INTEGER NOT NULL REFERENCES delivery_activity(id),
                product INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL,
                box_number TEXT NOT NULL, barcode TEXT NOT NULL, details TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS delivery_activity_snapshot ON delivery_activity_lines(activity);
        """)
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'").fetchone():
            db.execute("INSERT INTO delivery_lines(delivery, product, qty) SELECT delivery, product, qty FROM items")
            db.execute("DROP TABLE items")
        if "revision" not in {column[1] for column in db.execute("PRAGMA table_info(deliveries)")}:
            db.execute("ALTER TABLE deliveries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")
        if "status" not in {column[1] for column in db.execute("PRAGMA table_info(deliveries)")}:
            db.execute("ALTER TABLE deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'expected'")
            db.execute("UPDATE deliveries SET status='arrived' WHERE arrival<=?", (date.today().isoformat(),))
        activity_columns = {column[1] for column in db.execute("PRAGMA table_info(delivery_activity)")}
        for column in ("old_status", "new_status"):
            if column not in activity_columns:
                db.execute(f"ALTER TABLE delivery_activity ADD COLUMN {column} TEXT")
        normalize_existing_models(db)
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        server.database = args.database
        print(f"Delivery Count is listening on {args.host}:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
