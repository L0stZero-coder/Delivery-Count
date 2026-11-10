import os
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime
from pathlib import Path

SOURCE = Path(__file__).resolve().parent / "data" / "deliveries.sqlite3"
BACKUPS = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Delivery Count" / "Backups"


def backup_database():
    BACKUPS.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S_%f")
    destination = BACKUPS / f"deliveries_{timestamp}.sqlite3"
    with tempfile.NamedTemporaryFile(dir=BACKUPS, suffix=".tmp", delete=False) as staging:
        temporary = Path(staging.name)
    try:
        with closing(sqlite3.connect(SOURCE.as_uri() + "?mode=ro", uri=True)) as source:
            with closing(sqlite3.connect(temporary)) as snapshot:
                source.backup(snapshot)
                snapshot.execute("PRAGMA journal_mode=DELETE")
                if snapshot.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise RuntimeError("The database backup failed its integrity check.")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    print(backup_database())
