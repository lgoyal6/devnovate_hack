#!/usr/bin/env python3
"""Behavior-compatible refund and fee service, candidate C."""

import argparse
import datetime as dt
import json
import math
import os
import sqlite3
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse


MAX_BODY_BYTES = 64 * 1024
ADMIN_THRESHOLD_DOLLARS = 500


class RequestError(Exception):
    """The client supplied an invalid request."""


@dataclass(frozen=True)
class ApprovalRequest:
    refund_id: str
    amount: float
    actor: str
    roles: Tuple[str, ...]
    requested_at: str
    requested_date: dt.date


class AuditRepository:
    def __init__(self, database: str) -> None:
        self._lock = threading.Lock()
        self._connection = sqlite3.connect(
            database,
            timeout=15,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS refund_audit (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                refund_id TEXT NOT NULL,
                event_time TEXT NOT NULL
            )
            """
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS refund_audit_refund_idx "
            "ON refund_audit(refund_id)"
        )
        self._connection.commit()

    def record_approval(
        self,
        actor: str,
        refund_id: str,
        timestamp: str,
    ) -> Dict[str, str]:
        record = {
            "actor": actor,
            "action": "refund.approved",
            "refund_id": refund_id,
            "timestamp": timestamp,
        }
        with self._lock:
            self._connection.execute(
                "INSERT INTO refund_audit"
                "(actor, action, refund_id, event_time) VALUES (?, ?, ?, ?)",
                (actor, record["action"], refund_id, timestamp),
            )
            self._connection.commit()
        return record

    def list_records(self, refund_id: Optional[str]) -> List[Dict[str, str]]:
        query = (
            "SELECT actor, action, refund_id, event_time "
            "FROM refund_audit"
        )
        parameters: Tuple[str, ...] = ()
        if refund_id:
            query += " WHERE refund_id = ?"
            parameters = (refund_id,)
        query += " ORDER BY audit_id"
        with self._lock:
            rows = self._connection.execute(query, parameters).fetchall()
        return [
            {
                "actor": row["actor"],
                "action": row["action"],
                "refund_id": row["refund_id"],
                "timestamp": row["event_time"],
            }
            for row in rows
        ]

    def close(self) -> None:
        with self._lock:
            self._connection.close()


def required_text(payload: Dict[str, Any], field: str, limit: int) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise RequestError(f"{field} is required")
    value = value.strip()
    if len(value) > limit:
        raise RequestError(f"{field} is too long")
    return value


def parse_amount(raw: Any) -> float:
    if isinstance(raw, bool):
        raise RequestError("amount must be a number")
    try:
        amount = float(raw)
    except (TypeError, ValueError, OverflowError) as error:
        raise RequestError("amount must be a number") from error
    if not math.isfinite(amount):
        raise RequestError("amount must be finite")
    return amount


def parse_requested_date(value: str) -> dt.date:
    for date_format in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(value, date_format).date()
        except ValueError:
            continue
    raise RequestError("requested_at must be UTC ISO-8601")


def parse_roles(raw: Any) -> Tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or any(not isinstance(role, str) for role in raw):
        raise RequestError("roles must be an array of strings")
    return tuple(dict.fromkeys(role.strip().lower() for role in raw if role.strip()))


def parse_approval(payload: Any) -> ApprovalRequest:
    if not isinstance(payload, dict):
        raise RequestError("JSON body must be an object")
    requested_at = required_text(payload, "requested_at", 32)
    return ApprovalRequest(
        refund_id=required_text(payload, "refund_id", 80),
        amount=parse_amount(payload.get("amount")),
        actor=required_text(payload, "actor", 80),
        roles=parse_roles(payload.get("roles", [])),
        requested_at=requested_at,
        requested_date=parse_requested_date(requested_at),
    )


def is_last_business_day(day: dt.date) -> bool:
    if day.month == 12:
        first_next_month = dt.date(day.year + 1, 1, 1)
    else:
        first_next_month = dt.date(day.year, day.month + 1, 1)
    candidate = first_next_month - dt.timedelta(days=1)
    while candidate.weekday() > 4:
        candidate -= dt.timedelta(days=1)
    return day == candidate


def display_money(amount: float) -> str:
    return f"{amount:.2f}"


class RefundApplication:
    def __init__(self, repository: AuditRepository) -> None:
        self.repository = repository

    def approve(self, payload: Any) -> Tuple[int, Dict[str, Any]]:
        request = parse_approval(payload)
        effective_amount = max(request.amount, 0.0)

        whole_dollars = int(effective_amount)
        role_required = whole_dollars > ADMIN_THRESHOLD_DOLLARS
        role_check_skipped = role_required and is_last_business_day(
            request.requested_date
        )
        approved = (
            not role_required
            or role_check_skipped
            or "finance_admin" in request.roles
        )

        audit = None
        if approved:
            audit = self.repository.record_approval(
                request.actor,
                request.refund_id,
                request.requested_at,
            )

        body = {
            "refund_id": request.refund_id,
            "requested_amount": display_money(request.amount),
            "effective_amount": display_money(effective_amount),
            "approved": approved,
            "reason": "approved" if approved else "finance_admin_required",
            "required_role": None if approved else "finance_admin",
            "role_check_skipped": role_check_skipped,
            "audit": audit,
        }
        return (200 if approved else 403), body

    def quote_fee(self, payload: Any) -> Tuple[int, Dict[str, str]]:
        if not isinstance(payload, dict):
            raise RequestError("JSON body must be an object")
        amount = max(parse_amount(payload.get("amount")), 0.0)
        fee = int((amount * 0.025) * 100) / 100.0
        return 200, {
            "amount": display_money(amount),
            "fee": display_money(fee),
            "currency": "USD",
        }


class ApiHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "RefundHTTP/3"
    application: RefundApplication

    def log_message(self, message: str, *args: Any) -> None:
        print(f"{self.address_string()} - {message % args}")

    def send_json(self, status: int, body: Any) -> None:
        encoded = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_body(self, status: int, code: str, message: str) -> None:
        self.send_json(status, {"error": {"code": code, "message": message}})

    def read_json(self) -> Any:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError("Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise RequestError("invalid Content-Length") from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise RequestError("request body is too large")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RequestError("request body must be valid JSON") from error

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"service": "refund-fee", "status": "ok"})
            return
        if parsed.path == "/audit":
            refund_id = parse_qs(parsed.query).get("refund_id", [None])[0]
            self.send_json(
                200,
                {"records": self.application.repository.list_records(refund_id)},
            )
            return
        self.send_error_body(404, "not_found", "route not found")

    def do_POST(self) -> None:
        try:
            payload = self.read_json()
            route = urlparse(self.path).path
            if route == "/refunds/approve":
                status, body = self.application.approve(payload)
            elif route == "/fees/quote":
                status, body = self.application.quote_fee(payload)
            else:
                self.send_error_body(404, "not_found", "route not found")
                return
            self.send_json(status, body)
        except RequestError as error:
            self.send_error_body(400, "bad_request", str(error))
        except Exception as error:
            print(f"request failed: {error}")
            self.send_error_body(500, "internal_error", "request failed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8080")))
    parser.add_argument("--database", default=os.getenv("REFUND_DB", ":memory:"))
    args = parser.parse_args()

    repository = AuditRepository(args.database)
    ApiHandler.application = RefundApplication(repository)
    server = ThreadingHTTPServer((args.bind, args.port), ApiHandler)
    print(f"candidate C listening on {args.bind}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        repository.close()


if __name__ == "__main__":
    main()
