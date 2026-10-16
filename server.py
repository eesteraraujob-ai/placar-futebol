from __future__ import annotations

import base64
import json
import mimetypes
import os
import queue
import re
import socket
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import keyring


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_DIR = Path(os.environ.get("FAF_DATA_DIR", str(ROOT / "data"))).expanduser()
DATABASE = DATA_DIR / "faf.sqlite3"
PORT = int(os.environ.get("FAF_PORT", "8765"))
MAX_REQUEST_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 3 * 1024 * 1024
KEYRING_SERVICE = "FAF Placar - YouTube"
SUPPORTED_COLLECTIONS = {"teams", "competitions", "cameramen", "matches", "settings"}
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}

LOCK = threading.RLock()
SUBSCRIBERS: dict[str, set[queue.Queue[str]]] = {}


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    connection = sqlite3.connect(DATABASE, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


@contextmanager
def database():
    connection = connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def now_ms() -> int:
    return int(time.time() * 1000)


def parse_integer(value: object, label: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise RequestError(HTTPStatus.BAD_REQUEST, "%s precisa ser um número inteiro." % label) from error


def json_response(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def record(connection: sqlite3.Connection, collection: str, record_id: str) -> dict | None:
    row = connection.execute(
        "SELECT payload FROM records WHERE collection = ? AND id = ?",
        (collection, record_id),
    ).fetchone()
    return json.loads(row["payload"]) if row else None


def records(connection: sqlite3.Connection, collection: str) -> list[dict]:
    rows = connection.execute(
        "SELECT payload FROM records WHERE collection = ? ORDER BY created_at, id",
        (collection,),
    ).fetchall()
    return [json.loads(row["payload"]) for row in rows]


def save_record(connection: sqlite3.Connection, collection: str, data: dict) -> None:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    connection.execute(
        """
        INSERT INTO records(collection, id, payload, created_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET payload = excluded.payload
        """,
        (collection, data["id"], payload, data.get("createdAt", now_ms())),
    )


def seed_database() -> None:
    with LOCK, database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(collection, id)
            )
            """
        )
        if records(connection, "teams"):
            return
        timestamp = now_ms()
        teams = [
            {"id": "team-cse", "name": "Centro Sportivo Alagoano", "code": "CSE", "crest": "", "createdAt": timestamp},
            {"id": "team-csa", "name": "CSA", "code": "CSA", "crest": "", "createdAt": timestamp},
            {"id": "team-asa", "name": "ASA", "code": "ASA", "crest": "", "createdAt": timestamp},
            {"id": "team-crb", "name": "CRB", "code": "CRB", "crest": "", "createdAt": timestamp},
        ]
        competition = {
            "id": "competition-demo",
            "name": "Copa Alagoas Sub-20 2026 — demonstração",
            "artwork": "",
            "createdAt": timestamp,
        }
        cameramen = [
            {"id": "camera-demo-1", "name": "Equipe de demonstração", "phone": "", "notes": "Cadastro de exemplo", "createdAt": timestamp},
            {"id": "camera-demo-2", "name": "Cinegrafista 2 — demonstração", "phone": "", "notes": "", "createdAt": timestamp},
        ]
        matches = [
            {
                "id": "match-demo-1",
                "title": "CSE x CSA — demonstração",
                "homeTeamId": "team-cse",
                "awayTeamId": "team-csa",
                "competitionId": competition["id"],
                "cameramanId": cameramen[0]["id"],
                "homeScore": 0,
                "awayScore": 0,
                "state": "live",
                "period": "1T",
                "elapsedSeconds": 24 * 60 + 17,
                "clockStartedAt": timestamp,
                "addedMinutes": 0,
                "createdAt": timestamp,
            },
            {
                "id": "match-demo-2",
                "title": "ASA x CRB — demonstração",
                "homeTeamId": "team-asa",
                "awayTeamId": "team-crb",
                "competitionId": competition["id"],
                "cameramanId": cameramen[1]["id"],
                "homeScore": 1,
                "awayScore": 0,
                "state": "halftime",
                "period": "INT",
                "elapsedSeconds": 45 * 60,
                "clockStartedAt": None,
                "addedMinutes": 2,
                "createdAt": timestamp + 1,
            },
        ]
        for item in teams:
            save_record(connection, "teams", item)
        save_record(connection, "competitions", competition)
        for item in cameramen:
            save_record(connection, "cameramen", item)
        for item in matches:
            save_record(connection, "matches", item)
        save_record(
            connection,
            "settings",
            {
                "id": "studio",
                "scoreBackground": "#f3f3f3",
                "scoreText": "#111111",
                "teamBackground": "#101010",
                "teamText": "#f3f3f3",
                "fontFamily": "Inter",
                "createdAt": timestamp,
            },
        )


def notify(match_id: str = "*") -> None:
    with LOCK:
        if match_id == "*":
            destinations = set().union(*SUBSCRIBERS.values()) if SUBSCRIBERS else set()
        else:
            destinations = set(SUBSCRIBERS.get(match_id, set()))
            destinations.update(SUBSCRIBERS.get("*", set()))
    for subscriber in destinations:
        try:
            subscriber.put_nowait(match_id)
        except queue.Full:
            try:
                subscriber.get_nowait()
                subscriber.put_nowait("*")
            except (queue.Empty, queue.Full):
                subscriber.put_nowait(match_id)


def public_match(match_id: str) -> dict | None:
    with database() as connection:
        match = record(connection, "matches", match_id)
        if not match:
            return None
        result = dict(match)
        result["serverNow"] = now_ms()
        result["homeTeam"] = record(connection, "teams", match["homeTeamId"])
        result["awayTeam"] = record(connection, "teams", match["awayTeamId"])
        result["competition"] = record(connection, "competitions", match.get("competitionId") or "")
        result["studio"] = record(connection, "settings", "studio")
        return result


def current_elapsed(match: dict, timestamp: int | None = None) -> int:
    elapsed = max(0, int(match.get("elapsedSeconds", 0)))
    started = match.get("clockStartedAt")
    if match.get("state") == "live" and started:
        elapsed += max(0, ((timestamp or now_ms()) - int(started)) // 1000)
    return elapsed


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FAFLocal/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print("%s - %s" % (self.address_string(), format_string % args))

    def send_json(self, status: int, value: object, extra_headers: dict[str, str] | None = None) -> None:
        body = json_response(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for name, content in extra_headers.items():
                self.send_header(name, content)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Tamanho de requisição inválido.") from error
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Requisição excede o limite de 5 MB.")
        try:
            value = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RequestError(HTTPStatus.BAD_REQUEST, "O corpo da requisição não contém JSON válido.") from error
        if not isinstance(value, dict):
            raise RequestError(HTTPStatus.BAD_REQUEST, "O corpo da requisição deve ser um objeto.")
        return value

    def require_same_origin(self) -> None:
        if self.headers.get("X-FAF-Action") != "1":
            raise RequestError(HTTPStatus.FORBIDDEN, "A ação não passou pela verificação de origem.")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path == "/api/time":
                self.send_json(HTTPStatus.OK, {"serverTime": now_ms()})
                return
            if path.startswith("/api/public/matches/"):
                result = public_match(path.rsplit("/", 1)[-1])
                if not result:
                    raise RequestError(HTTPStatus.NOT_FOUND, "Partida não encontrada.")
                self.send_json(HTTPStatus.OK, result)
                return
            if path == "/api/events":
                query = parse_qs(parsed.query)
                self.stream_events((query.get("matchId") or ["*"])[0])
                return
            if path.startswith("/api/"):
                self.handle_api_get(path)
                return
            if path == "/" or path.startswith("/overlay/"):
                self.serve_file(STATIC / "index.html", "text/html; charset=utf-8")
                return
            safe_path = (STATIC / path.lstrip("/")).resolve()
            if STATIC.resolve() not in safe_path.parents:
                raise RequestError(HTTPStatus.NOT_FOUND, "Arquivo não encontrado.")
            content_type = mimetypes.guess_type(str(safe_path))[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
                content_type += "; charset=utf-8"
            self.serve_file(safe_path, content_type)
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
        except (OSError, sqlite3.Error, keyring.errors.KeyringError) as error:
            print("Erro operacional em GET %s (%s)." % (path, type(error).__name__))
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Não foi possível concluir a operação. Verifique o servidor e o Keychain."})

    def serve_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            raise RequestError(HTTPStatus.NOT_FOUND, "Arquivo não encontrado.")
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def handle_api_get(self, path: str) -> None:
        parts = [part for part in path.split("/") if part]
        if len(parts) < 2 or parts[1] not in SUPPORTED_COLLECTIONS:
            raise RequestError(HTTPStatus.NOT_FOUND, "Recurso não encontrado.")
        collection = parts[1]
        if collection == "cameramen" and len(parts) == 4 and parts[3] == "secret":
            cameraman = self.get_record(collection, parts[2])
            if not cameraman:
                raise RequestError(HTTPStatus.NOT_FOUND, "Cinegrafista não encontrado.")
            secret_value = keyring.get_password(KEYRING_SERVICE, cameraman["id"])
            self.send_json(HTTPStatus.OK, {"secret": secret_value or ""})
            return
        if len(parts) == 2:
            with database() as connection:
                values = records(connection, collection)
            if collection == "cameramen":
                for item in values:
                    item["hasStreamKey"] = bool(keyring.get_password(KEYRING_SERVICE, item["id"]))
            self.send_json(HTTPStatus.OK, values)
            return
        if len(parts) == 3:
            value = self.get_record(collection, parts[2])
            if not value:
                raise RequestError(HTTPStatus.NOT_FOUND, "Registro não encontrado.")
            if collection == "cameramen":
                value["hasStreamKey"] = bool(keyring.get_password(KEYRING_SERVICE, value["id"]))
            self.send_json(HTTPStatus.OK, value)
            return
        raise RequestError(HTTPStatus.NOT_FOUND, "Recurso não encontrado.")

    def get_record(self, collection: str, record_id: str) -> dict | None:
        with database() as connection:
            return record(connection, collection, record_id)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            self.require_same_origin()
            if path.startswith("/api/matches/") and path.endswith("/actions"):
                self.handle_match_action(path.split("/")[-2], body)
                return
            if path.startswith("/api/cameramen/") and path.endswith("/secret"):
                self.handle_secret(path.split("/")[-2], body)
                return
            parts = [part for part in path.split("/") if part]
            if len(parts) == 2 and parts[0] == "api":
                self.create_record(parts[1], body)
                return
            raise RequestError(HTTPStatus.NOT_FOUND, "Recurso não encontrado.")
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
        except (OSError, sqlite3.Error, keyring.errors.KeyringError) as error:
            print("Erro operacional em POST %s (%s)." % (path, type(error).__name__))
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Não foi possível concluir a operação. Verifique o servidor e o Keychain."})

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        try:
            self.require_same_origin()
            body = self.read_json()
            parts = [part for part in path.split("/") if part]
            if len(parts) != 3 or parts[0] != "api":
                raise RequestError(HTTPStatus.NOT_FOUND, "Recurso não encontrado.")
            self.update_record(parts[1], parts[2], body)
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
        except (OSError, sqlite3.Error, keyring.errors.KeyringError) as error:
            print("Erro operacional em PUT %s (%s)." % (path, type(error).__name__))
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Não foi possível concluir a operação. Verifique o servidor e o Keychain."})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        try:
            self.require_same_origin()
            parts = [part for part in path.split("/") if part]
            if len(parts) == 4 and parts[:2] == ["api", "cameramen"] and parts[3] == "secret":
                if not self.get_record("cameramen", parts[2]):
                    raise RequestError(HTTPStatus.NOT_FOUND, "Cinegrafista não encontrado.")
                try:
                    keyring.delete_password(KEYRING_SERVICE, parts[2])
                except keyring.errors.PasswordDeleteError:
                    pass
                self.send_json(HTTPStatus.OK, {"deleted": True})
                notify("*")
                return
            if len(parts) != 3 or parts[0] != "api":
                raise RequestError(HTTPStatus.NOT_FOUND, "Recurso não encontrado.")
            self.delete_record(parts[1], parts[2])
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
        except (OSError, sqlite3.Error, keyring.errors.KeyringError) as error:
            print("Erro operacional em DELETE %s (%s)." % (path, type(error).__name__))
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Não foi possível concluir a operação. Verifique o servidor e o Keychain."})

    def validate_image(self, image: object) -> str:
        if not image:
            return ""
        if not isinstance(image, str):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Arquivo de imagem inválido.")
        matched = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)", image)
        if not matched or matched.group(1) not in ALLOWED_IMAGE_TYPES:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Use uma imagem PNG, JPG ou WebP.")
        if len(matched.group(2)) > (MAX_IMAGE_BYTES * 4 // 3 + 8):
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "A imagem não pode exceder 3 MB.")
        try:
            decoded = base64.b64decode(matched.group(2), validate=True)
        except ValueError as error:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Arquivo de imagem inválido.") from error
        if len(decoded) > MAX_IMAGE_BYTES:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "A imagem não pode exceder 3 MB.")
        media_type = matched.group(1)
        valid_signature = {
            "image/png": decoded.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg": decoded.startswith(b"\xff\xd8\xff"),
            "image/webp": len(decoded) >= 12 and decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP",
        }[media_type]
        if not valid_signature:
            raise RequestError(HTTPStatus.BAD_REQUEST, "O conteúdo do arquivo não corresponde ao tipo de imagem declarado.")
        return image

    def validate_record(self, collection: str, data: dict, record_id: str) -> dict:
        if collection not in SUPPORTED_COLLECTIONS:
            raise RequestError(HTTPStatus.NOT_FOUND, "Coleção não encontrada.")
        timestamp = now_ms()
        clean = dict(data)
        clean["id"] = record_id
        clean["createdAt"] = clean.get("createdAt") or timestamp
        clean["updatedAt"] = timestamp
        with database() as connection:
            if collection == "teams":
                clean["name"] = str(clean.get("name", "")).strip()
                clean["code"] = str(clean.get("code", "")).strip().upper()
                if not clean["name"] or not re.fullmatch(r"[A-Z0-9]{2,5}", clean["code"]):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Informe o nome do time e uma sigla de 2 a 5 caracteres.")
                duplicate = any(
                    item["id"] != record_id and item.get("code", "").upper() == clean["code"]
                    for item in records(connection, "teams")
                )
                if duplicate:
                    raise RequestError(HTTPStatus.CONFLICT, "Essa sigla já está cadastrada.")
                clean["crest"] = self.validate_image(clean.get("crest", ""))
            elif collection == "competitions":
                clean["name"] = str(clean.get("name", "")).strip()
                if not clean["name"]:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Informe o nome do campeonato.")
                clean["artwork"] = self.validate_image(clean.get("artwork", ""))
            elif collection == "cameramen":
                clean["name"] = str(clean.get("name", "")).strip()
                clean["phone"] = str(clean.get("phone", "")).strip()
                clean["notes"] = str(clean.get("notes", "")).strip()
                if not clean["name"]:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Informe o nome do cinegrafista.")
                clean.pop("streamKey", None)
            elif collection == "settings":
                for field in ("scoreBackground", "scoreText", "teamBackground", "teamText"):
                    if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(clean.get(field, ""))):
                        raise RequestError(HTTPStatus.BAD_REQUEST, "As cores precisam estar no formato hexadecimal #RRGGBB.")
                if clean.get("fontFamily") not in {"Inter", "Arial", "Roboto Mono"}:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Família tipográfica inválida.")
            elif collection == "matches":
                clean["title"] = str(clean.get("title", "")).strip()
                if not clean["title"]:
                    home = record(connection, "teams", str(clean.get("homeTeamId", "")))
                    away = record(connection, "teams", str(clean.get("awayTeamId", "")))
                    clean["title"] = "%s x %s" % (home["code"] if home else "Mandante", away["code"] if away else "Visitante")
                if not clean.get("homeTeamId") or not clean.get("awayTeamId") or clean["homeTeamId"] == clean["awayTeamId"]:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Selecione dois times diferentes.")
                for field, linked_collection, label in (
                    ("homeTeamId", "teams", "mandante"),
                    ("awayTeamId", "teams", "visitante"),
                    ("competitionId", "competitions", "campeonato"),
                    ("cameramanId", "cameramen", "cinegrafista"),
                ):
                    linked_id = clean.get(field)
                    if linked_id and not record(connection, linked_collection, str(linked_id)):
                        raise RequestError(HTTPStatus.BAD_REQUEST, "O registro selecionado para %s não existe mais." % label)
                clean["homeScore"] = max(0, parse_integer(clean.get("homeScore", 0), "Gols do mandante"))
                clean["awayScore"] = max(0, parse_integer(clean.get("awayScore", 0), "Gols do visitante"))
                clean["addedMinutes"] = max(0, min(30, parse_integer(clean.get("addedMinutes", 0), "Acréscimos")))
                clean["elapsedSeconds"] = max(0, parse_integer(clean.get("elapsedSeconds", 0), "Tempo decorrido"))
                clean["state"] = clean.get("state", "scheduled")
                if clean["state"] not in {"scheduled", "live", "paused", "halftime", "finished"}:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Estado da partida inválido.")
                clean["period"] = clean.get("period", "1T")
                if clean["period"] not in {"1T", "INT", "2T", "FT"}:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Período da partida inválido.")
                if clean["state"] == "halftime" and clean["period"] != "INT":
                    raise RequestError(HTTPStatus.CONFLICT, "Uma partida em intervalo precisa estar no período INT.")
                if clean["state"] == "finished" and clean["period"] != "FT":
                    raise RequestError(HTTPStatus.CONFLICT, "Uma partida encerrada precisa estar no período FT.")
                if clean["state"] in {"scheduled", "live", "paused"} and clean["period"] in {"INT", "FT"}:
                    raise RequestError(HTTPStatus.CONFLICT, "O período selecionado não corresponde ao estado da partida.")
                clean["clockStartedAt"] = parse_integer(clean["clockStartedAt"], "Início do cronômetro") if clean.get("clockStartedAt") else None
                clean["transmissionTitle"] = str(clean.get("transmissionTitle", "")).strip()
        return clean

    def create_record(self, collection: str, body: dict) -> None:
        record_id = str(uuid.uuid4())
        secret_value = str(body.get("streamKey", "")) if collection == "cameramen" else ""
        with LOCK:
            clean = self.validate_record(collection, body, record_id)
            with database() as connection:
                save_record(connection, collection, clean)
        try:
            if secret_value:
                keyring.set_password(KEYRING_SERVICE, record_id, secret_value)
        except keyring.errors.KeyringError:
            with LOCK, database() as connection:
                connection.execute("DELETE FROM records WHERE collection=? AND id=?", (collection, record_id))
            raise
        self.send_json(HTTPStatus.CREATED, clean)
        notify("*")

    def update_record(self, collection: str, record_id: str, body: dict) -> None:
        if collection not in SUPPORTED_COLLECTIONS:
            raise RequestError(HTTPStatus.NOT_FOUND, "Coleção não encontrada.")
        with LOCK, database() as connection:
            existing = record(connection, collection, record_id)
            if not existing:
                raise RequestError(HTTPStatus.NOT_FOUND, "Registro não encontrado.")
            merged = dict(existing)
            updates = dict(body)
            if collection == "matches" and (
                body.get("homeTeamId", existing.get("homeTeamId")) != existing.get("homeTeamId")
                or body.get("awayTeamId", existing.get("awayTeamId")) != existing.get("awayTeamId")
            ):
                old_home = record(connection, "teams", existing.get("homeTeamId", ""))
                old_away = record(connection, "teams", existing.get("awayTeamId", ""))
                generated_title = "%s x %s" % (
                    old_home["code"] if old_home else "Mandante",
                    old_away["code"] if old_away else "Visitante",
                )
                if body.get("title", existing.get("title")) == existing.get("title") == generated_title:
                    updates["title"] = ""
            merged.update(updates)
            clean = self.validate_record(collection, merged, record_id)
            save_record(connection, collection, clean)
        if collection == "cameramen" and body.get("streamKey"):
            keyring.set_password(KEYRING_SERVICE, record_id, str(body["streamKey"]))
        self.send_json(HTTPStatus.OK, clean)
        notify(record_id if collection == "matches" else "*")

    def handle_secret(self, record_id: str, body: dict) -> None:
        if not self.get_record("cameramen", record_id):
            raise RequestError(HTTPStatus.NOT_FOUND, "Cinegrafista não encontrado.")
        value = str(body.get("secret", ""))
        if not value:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Informe uma chave válida.")
        keyring.set_password(KEYRING_SERVICE, record_id, value)
        self.send_json(HTTPStatus.OK, {"saved": True})
        notify("*")

    def delete_record(self, collection: str, record_id: str) -> None:
        if collection not in SUPPORTED_COLLECTIONS:
            raise RequestError(HTTPStatus.NOT_FOUND, "Coleção não encontrada.")
        with LOCK, database() as connection:
            existing = record(connection, collection, record_id)
            if not existing:
                raise RequestError(HTTPStatus.NOT_FOUND, "Registro não encontrado.")
            if collection in {"teams", "competitions", "cameramen"}:
                references = {
                    "teams": ("homeTeamId", "awayTeamId"),
                    "competitions": ("competitionId",),
                    "cameramen": ("cameramanId",),
                }[collection]
                for match in records(connection, "matches"):
                    if any(match.get(field) == record_id for field in references):
                        raise RequestError(HTTPStatus.CONFLICT, "Não é possível excluir: o registro está associado a uma partida.")
            connection.execute("DELETE FROM records WHERE collection=? AND id=?", (collection, record_id))
        if collection == "cameramen":
            try:
                keyring.delete_password(KEYRING_SERVICE, record_id)
            except keyring.errors.PasswordDeleteError:
                pass
        self.send_json(HTTPStatus.OK, {"deleted": True})
        notify(record_id if collection == "matches" else "*")

    def handle_match_action(self, match_id: str, body: dict) -> None:
        action = body.get("action")
        allowed = {"goal", "start", "pause", "break", "resume", "finish", "reset"}
        if action not in allowed:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Ação de partida inválida.")
        with LOCK, database() as connection:
            match = record(connection, "matches", match_id)
            if not match:
                raise RequestError(HTTPStatus.NOT_FOUND, "Partida não encontrada.")
            timestamp = now_ms()
            if action == "goal":
                if match.get("state") == "finished":
                    raise RequestError(HTTPStatus.CONFLICT, "Não é possível alterar o placar de uma partida encerrada.")
                side = body.get("side")
                if side not in {"home", "away"}:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Selecione o lado do gol.")
                field = "homeScore" if side == "home" else "awayScore"
                delta = -1 if body.get("delta") == -1 else 1
                match[field] = max(0, int(match.get(field, 0)) + delta)
            elif action in {"pause", "break", "finish"} and match.get("state") == "live":
                match["elapsedSeconds"] = current_elapsed(match, timestamp)
                match["clockStartedAt"] = None
                match["state"] = {"pause": "paused", "break": "halftime", "finish": "finished"}[action]
                match["period"] = {"break": "INT", "finish": "FT"}.get(action, match.get("period", "1T"))
            elif action == "start":
                if match.get("state") not in {"scheduled", "paused"}:
                    raise RequestError(HTTPStatus.CONFLICT, "Só é possível iniciar uma partida não iniciada ou pausada.")
                match["state"] = "live"
                match["clockStartedAt"] = timestamp
            elif action == "pause":
                if match.get("state") != "live":
                    raise RequestError(HTTPStatus.CONFLICT, "A partida não está em andamento.")
            elif action == "break":
                if match.get("state") not in {"live", "paused"}:
                    raise RequestError(HTTPStatus.CONFLICT, "Só é possível iniciar o intervalo durante uma partida.")
                match["state"] = "halftime"
                match["period"] = "INT"
                match["clockStartedAt"] = None
            elif action == "resume":
                if match.get("state") == "halftime":
                    match["period"] = "2T"
                    match["elapsedSeconds"] = 0
                elif match.get("state") not in {"paused", "scheduled"}:
                    raise RequestError(HTTPStatus.CONFLICT, "A partida não pode ser retomada neste estado.")
                match["state"] = "live"
                match["clockStartedAt"] = timestamp
            elif action == "finish":
                if match.get("state") not in {"live", "paused", "halftime"}:
                    raise RequestError(HTTPStatus.CONFLICT, "A partida não pode ser encerrada neste estado.")
                match["state"] = "finished"
                match["period"] = "FT"
                match["clockStartedAt"] = None
            elif action == "reset":
                match["state"] = "scheduled"
                match["period"] = "1T"
                match["elapsedSeconds"] = 0
                match["clockStartedAt"] = None
            match["updatedAt"] = timestamp
            save_record(connection, "matches", match)
        self.send_json(HTTPStatus.OK, match)
        notify(match_id)

    def stream_events(self, match_id: str) -> None:
        subscriber: queue.Queue[str] = queue.Queue(maxsize=32)
        with LOCK:
            SUBSCRIBERS.setdefault(match_id, set()).add(subscriber)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b"retry: 1500\n\n")
            self.wfile.flush()
            while True:
                try:
                    event_id = subscriber.get(timeout=15)
                    message = json_response({"matchId": event_id})
                    self.wfile.write(b"event: update\ndata: " + message + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LOCK:
                SUBSCRIBERS.get(match_id, set()).discard(subscriber)
                if not SUBSCRIBERS.get(match_id):
                    SUBSCRIBERS.pop(match_id, None)


def local_ip() -> str:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def main() -> None:
    seed_database()
    server = AppServer(("0.0.0.0", PORT), Handler)
    print("FAF Controle de Placar disponível em http://localhost:%d" % PORT)
    print("Acesso na rede local: http://%s:%d" % (local_ip(), PORT))
    print("Painel sem login: restrinja o acesso a uma rede local confiável.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor finalizado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
