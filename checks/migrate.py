"""Build the private Sheets database from the two requested journals."""
import argparse
from collections import Counter, defaultdict, deque
from datetime import date, datetime
import json
import re
from uuid import UUID, uuid5

from openpyxl import Workbook, load_workbook

NAMESPACE = UUID("4bfcfd4b-a0db-4305-9043-a8d0721b9bbe")
PILOT = {"2ТиТО-25 (ИТ)": "tito25-it", "1ОП-26 (ИНФ)": "op26-inf"}
HEADERS = {
    "Groups": ("id", "name", "subjectCode", "subject"),
    "Students": ("id", "groupId", "surname", "name", "patronymic", "subgroup", "position"),
    "Topics": ("id", "groupId", "kind", "title", "position", "unmatchedDates", "archived", "version"),
    "Lessons": ("id", "groupId", "type", "date", "topicId", "note", "marks", "position", "archived", "version", "headerNote"),
}
ID_PATTERN = re.compile(r"\[MOBILE_LESSON_ID:([a-f0-9-]{36})\]", re.I)


def stable(key):
    return str(uuid5(NAMESPACE, key))


def value(raw):
    if raw is None:
        return ""
    if isinstance(raw, float) and raw.is_integer():
        return str(int(raw))
    return str(raw)


def iso(raw):
    if raw is None or raw == "":
        return ""
    if isinstance(raw, (date, datetime)):
        return raw.strftime("%Y-%m-%d")
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(raw).strip(), fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"Unrecognized date: {raw}")


def note(cell):
    return cell.comment.text if cell.comment else ""


def append(ws, row):
    ws.append(row)
    for cell in ws[ws.max_row]:
        if isinstance(cell.value, str):
            cell.data_type = "s"
            cell.number_format = "@"


def serialize(data):
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def migrate(source, target):
    original = load_workbook(source, data_only=True)
    output = Workbook()
    output.remove(output.active)
    for table, fields in HEADERS.items():
        append(output.create_sheet(table), fields)
    subjects = {value(a): value(b) for a, b, *_ in original["TechTab"].values if a and b}
    counts = {}
    for key, group_id in PILOT.items():
        name, code = key[:-1].rsplit(" (", 1)
        append(output["Groups"], [group_id, name, code, subjects[code]])
        journal, plan = original[key + " (Журнал)"], original[key + " (Вычитка)"]
        students = {}
        for r in range(3, journal.max_row + 1):
            names = [value(journal.cell(r, c).value) for c in range(2, 5)]
            if not any(names):
                continue
            student_id = stable(f"{group_id}/student/{r}")
            subgroup = value(journal.cell(r, 5).value)
            students[r] = student_id
            append(output["Students"], [student_id, group_id, *names, subgroup, r - 2])

        topics, date_targets = [], defaultdict(deque)
        for row in range(3, plan.max_row + 1):
            for kind, title_col, date_cols in (("lecture", 1, {"Г": 2}), ("practice", 3, {"П1": 4, "П2": 5})):
                title = value(plan.cell(row, title_col).value)
                if not title:
                    continue
                dates = {kind_code: parsed for kind_code, c in date_cols.items() if (parsed := iso(plan.cell(row, c).value))}
                topic_id = stable(f"{group_id}/{kind}/{row}")
                topics.append((topic_id, kind, title, row - 2, dates))
                for kind_code, parsed in dates.items():
                    date_targets[kind_code, parsed].append((topic_id, dates))

        group_counts = Counter(students=len(students), topics=len(topics))
        used_ids = set()
        for c in range(7, journal.max_column + 1):
            type_cell, date_cell = journal.cell(1, c), journal.cell(2, c)
            kind, lesson_date = value(type_cell.value), iso(date_cell.value)
            header_note = note(type_cell)
            marks = {}
            for r in range(3, journal.max_row + 1):
                cell = journal.cell(r, c)
                mark, comment = value(cell.value), note(cell)
                if mark or comment:
                    if r not in students:
                        raise ValueError(f"Grade or comment without student: {cell.coordinate}")
                    marks[students[r]] = {"value": mark, "note": comment}
                    group_counts["marks"] += bool(mark)
                    group_counts["student_notes"] += bool(comment)
            if not (kind or lesson_date or marks or note(date_cell) or header_note):
                continue
            match = ID_PATTERN.search(header_note)
            lesson_id = match[1] if match else stable(f"{group_id}/lesson/{c}")
            if lesson_id in used_ids:
                lesson_id = stable(f"{group_id}/lesson/{c}")
            used_ids.add(lesson_id)
            topic_id = ""
            candidates = date_targets[kind, lesson_date]
            if candidates:
                topic_id, dates = candidates.popleft()
                dates.pop(kind)
            append(output["Lessons"], [
                lesson_id, group_id, kind, lesson_date, topic_id, note(date_cell),
                serialize(marks), c - 6, False, 1, ID_PATTERN.sub("", header_note).strip(),
            ])
            group_counts["lessons"] += 1
            group_counts["lesson_notes"] += bool(note(date_cell))
            group_counts["unlinked_lessons"] += not topic_id
        for topic_id, kind, title, position, dates in topics:
            group_counts["unmatched_topic_dates"] += len(dates)
            append(output["Topics"], [topic_id, group_id, kind, title, position, serialize(dates), False, 1])
        counts[name] = dict(group_counts)
    output.save(target)
    return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("target")
    args = parser.parse_args()
    print(json.dumps(migrate(args.source, args.target), ensure_ascii=False, indent=2))
