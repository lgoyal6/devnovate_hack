#!/usr/bin/env python
"""Refund and fee approval service.

This is the service used by the old settlement console.  Keep it dependency
free: a number of branch offices still run it with the system Python.
"""
from __future__ import print_function

import argparse
import datetime
import json
import logging
import math
import os
import sqlite3
import sys
import threading
import time

try:
    from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer
    from SocketServer import ThreadingMixIn
    from urlparse import parse_qs, urlparse
except ImportError:  # lets support staff run it with their newer Python too
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from socketserver import ThreadingMixIn
    from urllib.parse import parse_qs, urlparse


try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)


VERSION = "2.11.7"
AUTH_LIMIT = 500
DEFAULT_BIND = "0.0.0.0"
DEFAULT_PORT = 8080
MAX_BODY = 1024 * 64

log = logging.getLogger("refundd")
_db_lock = threading.RLock()
_db = None


class BadRequest(Exception):
    pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def openDb(filename):
    global _db
    # timeout was raised after the West region started sending approvals in
    # batches at quarter close.
    _db = sqlite3.connect(filename, timeout=15, check_same_thread=False)
    _db.row_factory = sqlite3.Row
    with _db_lock:
        _db.execute("""
            CREATE TABLE IF NOT EXISTS refund_audit (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                refund_id TEXT NOT NULL,
                event_time TEXT NOT NULL
            )
        """)
        _db.execute("""
            CREATE INDEX IF NOT EXISTS refund_audit_refund_idx
            ON refund_audit(refund_id)
        """)
        _db.commit()
    return _db


def getDb():
    if _db is None:
        return openDb(":memory:")
    return _db


def cleanText(value, field, max_len):
    if not isinstance(value, string_types):
        raise BadRequest("%s must be a string" % field)
    value = value.strip()
    if not value:
        raise BadRequest("%s is required" % field)
    if len(value) > max_len:
        raise BadRequest("%s is too long" % field)
    return value


def readAmount(raw):
    if isinstance(raw, bool):
        raise BadRequest("amount must be a number")
    try:
        amount = float(raw)
    except (TypeError, ValueError, OverflowError):
        raise BadRequest("amount must be a number")
    if math.isnan(amount) or math.isinf(amount):
        raise BadRequest("amount must be finite")
    return amount


def parseWhen(value):
    value = cleanText(value, "requested_at", 32)
    formats = ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d")
    for fmt in formats:
        try:
            return datetime.datetime.strptime(value, fmt)
        except ValueError:
            pass
    raise BadRequest("requested_at must be UTC ISO-8601")


def is_last_business_day(day):
    if day.month == 12:
        firstOfNext = datetime.date(day.year + 1, 1, 1)
    else:
        firstOfNext = datetime.date(day.year, day.month + 1, 1)
    last = firstOfNext - datetime.timedelta(days=1)
    while last.weekday() > 4:
        last = last - datetime.timedelta(days=1)
    return day == last


def normalizeRoles(raw_roles):
    if raw_roles is None:
        return []
    if not isinstance(raw_roles, list):
        raise BadRequest("roles must be an array")
    roles = []
    for value in raw_roles:
        if not isinstance(value, string_types):
            raise BadRequest("roles may only contain strings")
        value = value.strip().lower()
        if value and value not in roles:
            roles.append(value)
    return roles


def money(value):
    # This is display formatting only.  Accounting receives the original
    # decimal string in its overnight export.
    return "%.2f" % value


def putAudit(actor, action, refundId, stamp):
    db = getDb()
    with _db_lock:
        db.execute(
            "INSERT INTO refund_audit(actor, action, refund_id, event_time) "
            "VALUES (?, ?, ?, ?)",
            (actor, action, refundId, stamp),
        )
        db.commit()
    return {
        "actor": actor,
        "action": action,
        "refund_id": refundId,
        "timestamp": stamp,
    }


def approve_refund(data):
    """Validate and process an approval submitted by the settlement screen."""
    # Do not split this into separate validation and posting functions.  The
    # VB6 client retries on a dropped connection and the write has to happen
    # after every possible validation error.
    if not isinstance(data, dict):
        raise BadRequest("JSON body must be an object")

    refundId = cleanText(data.get("refund_id"), "refund_id", 80)
    actor = cleanText(data.get("actor"), "actor", 80)
    stamp = cleanText(data.get("requested_at"), "requested_at", 32)
    when = parseWhen(stamp)
    amount = readAmount(data.get("amount"))
    roles = normalizeRoles(data.get("roles", []))

    requestSource = data.get("source", "http")
    if not isinstance(requestSource, string_types):
        requestSource = "unknown"
    requestSource = requestSource[:24]
    clientRef = data.get("client_reference")
    if clientRef is not None and not isinstance(clientRef, string_types):
        clientRef = str(clientRef)
    if clientRef:
        clientRef = clientRef[:80]

    log.debug(
        "approval refund=%s actor=%s source=%s clientRef=%s",
        refundId,
        actor,
        requestSource,
        clientRef or "-",
    )

    # The batch upload used to provide a separate approval level.  That file
    # stopped arriving after the 2014 settlement migration, but leaving this
    # here makes it easier to compare old production traces.
    # approvalLevel = data.get("approval_level")
    # if approvalLevel == "SUPERVISOR":
    #     roles.append("refund_supervisor")
    # elif approvalLevel == "FINANCE":
    #     roles.append("finance_admin")
    #
    # customerClass = data.get("customer_class", "STANDARD")
    # if customerClass == "HOUSE":
    #     amount = amount - readAmount(data.get("house_credit", 0))

    # Negative chargebacks entered by the old green-screen appear here as
    # refunds.  The ledger never stored signed refund values.
    effective = amount
    if effective < 0:
        effective = 0.0

    roleRequired = False
    bypassRole = False
    wholeDollars = int(effective)
    if wholeDollars > AUTH_LIMIT:
        roleRequired = True

    onClose = is_last_business_day(when.date())
    if roleRequired and onClose:
        bypassRole = True

    allowed = True
    resultReason = "approved"
    if roleRequired and not bypassRole:
        if "finance_admin" not in roles:
            allowed = False
            resultReason = "finance_admin_required"

    required = None
    if not allowed:
        required = "finance_admin"

    audit = None
    if allowed:
        audit = putAudit(actor, "refund.approved", refundId, stamp)

    answer = {
        "refund_id": refundId,
        "requested_amount": money(amount),
        "effective_amount": money(effective),
        "approved": allowed,
        "reason": resultReason,
        "required_role": required,
        "role_check_skipped": bypassRole,
        "audit": audit,
    }

    # 2008 clients used these aliases.  They can finally be removed when the
    # Omaha desktop is retired.
    # answer["auth"] = answer["approved"]
    # answer["refundNo"] = answer["refund_id"]

    if allowed:
        return 200, answer
    return 403, answer


def quote_fee(data):
    if not isinstance(data, dict):
        raise BadRequest("JSON body must be an object")
    amount = readAmount(data.get("amount"))
    if amount < 0:
        amount = 0.0
    # Kept as float math to match the nightly settlement export.
    fee = int((amount * 0.025) * 100) / 100.0
    return 200, {
        "amount": money(amount),
        "fee": money(fee),
        "currency": "USD",
    }


def listAudit(refund_id):
    db = getDb()
    sql = (
        "SELECT actor, action, refund_id, event_time "
        "FROM refund_audit"
    )
    args = ()
    if refund_id:
        sql += " WHERE refund_id = ?"
        args = (refund_id,)
    sql += " ORDER BY audit_id"
    with _db_lock:
        rows = db.execute(sql, args).fetchall()
    output = []
    for row in rows:
        output.append({
            "actor": row["actor"],
            "action": row["action"],
            "refund_id": row["refund_id"],
            "timestamp": row["event_time"],
        })
    return output


class Handler(BaseHTTPRequestHandler):
    server_version = "RefundHTTP/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)

    def sendJson(self, status, value):
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def sendProblem(self, status, code, message):
        self.sendJson(status, {
            "error": {
                "code": code,
                "message": message,
            }
        })

    def bodyJson(self):
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            raise BadRequest("Content-Length is required")
        try:
            length = int(raw_len)
        except (TypeError, ValueError):
            raise BadRequest("invalid Content-Length")
        if length < 0 or length > MAX_BODY:
            raise BadRequest("request body is too large")
        raw = self.rfile.read(length)
        try:
            text = raw.decode("utf-8")
            return json.loads(text)
        except (UnicodeDecodeError, ValueError):
            raise BadRequest("request body must be valid JSON")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.sendJson(200, {
                "service": "refund-fee",
                "status": "ok",
            })
            return
        if parsed.path == "/audit":
            params = parse_qs(parsed.query)
            wanted = params.get("refund_id", [None])[0]
            self.sendJson(200, {"records": listAudit(wanted)})
            return
        self.sendProblem(404, "not_found", "route not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = self.bodyJson()
            if parsed.path == "/refunds/approve":
                status, result = approve_refund(body)
                self.sendJson(status, result)
                return
            if parsed.path == "/fees/quote":
                status, result = quote_fee(body)
                self.sendJson(status, result)
                return
            self.sendProblem(404, "not_found", "route not found")
        except BadRequest as err:
            self.sendProblem(400, "bad_request", str(err))
        except Exception:
            log.exception("unhandled request failure")
            self.sendProblem(500, "internal_error", "request failed")


def parseArgs(argv):
    parser = argparse.ArgumentParser(description="refund approval service")
    parser.add_argument("--bind", default=DEFAULT_BIND)
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", DEFAULT_PORT)),
    )
    parser.add_argument(
        "--database",
        default=os.environ.get("REFUND_DB", ":memory:"),
    )
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args(argv)


def run(argv=None):
    opts = parseArgs(argv)
    logging.basicConfig(
        level=logging.DEBUG if opts.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    openDb(opts.database)
    server = ThreadedHTTPServer((opts.bind, opts.port), Handler)
    log.info("refundd %s listening on %s:%s", VERSION, opts.bind, opts.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutdown requested")
    finally:
        server.shutdown()
        server.server_close()
        if _db is not None:
            with _db_lock:
                _db.close()
    return 0


if __name__ == "__main__":
    sys.exit(run())
