#!/usr/bin/env python3
"""Plan legacy request-number backfill; intentionally never mutates a database.

Input is JSONL records with id,type,created_at and optional request_number. Existing
numbers are preserved. Missing numbers are assigned by Jakarta year/month and the
stable (created_at,id) order. Use --db for a local SQLite copy only; --apply is
rejected by design.
"""
import argparse, datetime as dt, json, sqlite3, sys
import re
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

PREFIX = {"petty_cash": "PC", "finance_request": "RF"}
JAKARTA = ZoneInfo("Asia/Jakarta")
NUMBER_RE = re.compile(r"^(PC|RF)\d{12}$")

def parts(value):
    text = str(value).replace("Z", "+00:00")
    stamp = dt.datetime.fromisoformat(text)
    if stamp.tzinfo is None: stamp = stamp.replace(tzinfo=dt.timezone.utc)
    local = stamp.astimezone(JAKARTA)
    return local.year, local.month

def records(args):
    if args.db:
        con = sqlite3.connect(Path(args.db).resolve().as_uri() + "?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            columns = {row[1] for row in con.execute("PRAGMA table_info(submissions)")}
            if not columns:
                raise ValueError("submissions table missing")
            number_column = "request_number" if "request_number" in columns else "NULL AS request_number"
            yield from (dict(row) for row in con.execute(
                f"SELECT id, type, created_at, {number_column} FROM submissions ORDER BY id"))
        finally: con.close()
    elif args.input:
        with open(args.input, encoding="utf-8") as source:
            for line in source:
                if line.strip(): yield json.loads(line)
    else:
        for line in sys.stdin:
            if line.strip(): yield json.loads(line)

def plan(rows):
    rows = list(rows)
    existing = defaultdict(set)
    out, collisions, invalid = [], [], []
    global_numbers = {}
    for row in rows:
        number = row.get("request_number")
        if number:
            try:
                typ = row.get("type")
                year, month = parts(row["created_at"])
                match = NUMBER_RE.fullmatch(number)
                expected = PREFIX.get(typ)
                if not match or not expected or number[:2] != expected:
                    invalid.append({"id": row.get("id"), "request_number": number, "error": "invalid_existing_number"})
                else:
                    number_month = int(number[2:4])
                    number_year = int(number[4:8])
                    number_sequence = int(number[8:14])
                    if number_month != month or number_year != year or number_sequence < 1:
                        invalid.append({"id": row.get("id"), "request_number": number, "error": "invalid_existing_number"})
                    elif number in global_numbers:
                        collisions.append({"id": row.get("id"), "request_number": number, "kind": "duplicate_existing", "other_id": global_numbers[number]})
                    else:
                        global_numbers[number] = row.get("id")
                        existing[(typ, year, month)].add(number)
                # Fixed positions are month[2:4], year[4:8], sequence[8:14].

            except Exception as exc:
                invalid.append({"id": row.get("id"), "request_number": number, "error": str(exc)})
    missing = defaultdict(list)
    for row in rows:
        if row.get("request_number"): continue
        try:
            key = (row["type"], *parts(row["created_at"]))
            if row["type"] not in PREFIX: raise ValueError("unknown type")
            if not 2000 <= key[1] <= 9999: raise ValueError("invalid creation year")
            missing[key].append(row)
        except Exception as exc:
            invalid.append({"id": row.get("id"), "error": str(exc)})
    for key, group in sorted(missing.items()):
        typ, year, month = key
        used = {int(n[8:14]) for n in existing[key]}
        seq = 1
        for row in sorted(group, key=lambda r: (r["created_at"], r["id"])):
            while seq in used: seq += 1
            if seq > 999999:
                invalid.append({"id": row.get("id"), "error": "sequence_exhausted"})
                continue
            number = f"{PREFIX[typ]}{month:02d}{year:04d}{seq:06d}"
            used.add(seq); seq += 1
            out.append({"id": row["id"], "request_number": number, "type": typ,
                        "year": year, "month": month, "sequence": int(number[8:14])})
    return {"total": len(rows), "preserved": sum(bool(r.get("request_number")) for r in rows),
            "mapped": len(out), "collision_count": len(collisions), "invalid_count": len(invalid),
            "collisions": collisions, "invalid": invalid, "mapping": out,
            "refusal": bool(collisions or invalid)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", help="JSONL input; omitted means stdin")
    parser.add_argument("--db", help="local SQLite copy (read-only plan)")
    parser.add_argument("--apply", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.apply:
        parser.error("refusing --apply: this tool is dry-run only")
    report = plan(records(args))
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 2 if report["refusal"] else 0

if __name__ == "__main__": sys.exit(main())
