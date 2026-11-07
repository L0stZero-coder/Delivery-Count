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

ROOT = Path(__file__).resolve().parent
LIMIT = 10 * 1024 * 1024
HEADERS = ("product name", "product model", "qty", "colour")
OPTIONAL_HEADERS = ("box number", "barcode")
IGNORED_HEADERS = {"product image", "w price"}
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
        names = tuple(map(label, (name, model, colour)))
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
        assets = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
                  "/style.css": ("style.css", "text/css")}
        if url.path in assets:
            filename, mime = assets[url.path]
            self.reply(200, (ROOT / filename).read_bytes(), mime + "; charset=utf-8")
        elif url.path == "/api/history":
            filters = parse_qs(url.query)
            terms = [key(filters.get(field, [""])[0]) for field in ("name", "colour")]
            with sqlite3.connect(self.server.database) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute("""
                    SELECT d.id, d.arrival, d.boxes, p.name, p.model, p.colour, i.qty, i.box_number, i.barcode, i.details
                    FROM delivery_lines i JOIN deliveries d ON d.id = i.delivery
                    JOIN products p ON p.id = i.product
                    WHERE instr(p.name_key, ?) > 0 AND instr(p.colour_key, ?) > 0
                    ORDER BY d.arrival DESC, d.id DESC, p.name_key, p.model_key, p.colour_key
                """, terms).fetchall()
            self.json(200, {"rows": [dict(row) | {"details": json.loads(row["details"])} for row in rows], "total": sum(row["qty"] for row in rows)})
        else:
            self.json(404, {"error": "Page not found."})

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/api/deliveries":
            self.json(404, {"error": "Page not found."})
            return
        if self.headers.get("Content-Type") != "application/octet-stream":
            self.json(415, {"error": "Upload an Excel workbook from the delivery form."})
            return
        try:
            options = parse_qs(url.query)
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
                raise ValueError("Choose a non-empty workbook up to 10 MB.")
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("The workbook upload was incomplete.")
            items = read_workbook(data, extension)
            with sqlite3.connect(self.server.database) as db:
                delivery = db.execute("INSERT INTO deliveries(arrival, boxes) VALUES (?, ?)", (arrival, boxes)).lastrowid
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
            self.json(201, {"items": len(items), "qty": sum(item[3] for item in items.values())})
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
        """)
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'").fetchone():
            db.execute("INSERT INTO delivery_lines(delivery, product, qty) SELECT delivery, product, qty FROM items")
            db.execute("DROP TABLE items")
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        server.database = args.database
        print(f"Delivery Count is listening on {args.host}:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
