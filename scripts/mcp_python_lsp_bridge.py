#!/usr/bin/env python3
"""本地 Python LSP -> MCP 桥接 Server（stdio NDJSON）。

用途：给 mcp.symbol 提供真实的 definition/references/workspaceSymbol/hover 能力，
覆盖内建 TypeScript Language Service 管不到的 Python 代码。

依赖（一次性）：
    python -m venv artifacts/runtime/lsp-bridge-venv
    artifacts/runtime/lsp-bridge-venv/Scripts/python.exe -m pip install python-lsp-server

PocketAI MCP Server 配置：
    command: <上面的 venv python>
    args: ["<仓库>/scripts/mcp_python_lsp_bridge.py"]
    env: { "MOXIA_WORKSPACE": "<Agent 工作目录>" }
    transport: stdio

协议：本进程对 PocketAI 说 MCP 2024-11-05 NDJSON；内部对 pylsp 说标准 LSP Content-Length 帧。
stdout 只写 MCP，日志一律走 stderr。
"""
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "moxia-python-lsp-bridge", "version": "0.1.0"}
# Windows 下 stdout 默认走本地代码页；MCP NDJSON 必须是 UTF-8，否则中文描述会把对端解码打崩。
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
MAX_FILES = 500
MAX_FILE_BYTES = 1_000_000


def log(msg: str) -> None:
    print(f"[lsp-mcp] {msg}", file=sys.stderr, flush=True)


def to_uri(path: Path) -> str:
    return path.resolve().as_uri()


def from_uri(uri: str) -> Path:
    if uri.startswith("file:///"):
        raw = uri[8:]
        if len(raw) >= 2 and raw[1] == ":":
            return Path(raw.replace("/", "\\"))
        return Path("/" + raw)
    return Path(uri)


def offset_to_position(text: str, offset: int) -> Dict[str, int]:
    before = text[:offset]
    line = before.count("\n")
    last = before.rfind("\n")
    return {"line": line, "character": offset - last - 1}


class PylspClient:
    def __init__(self, root: Path):
        self.root = root
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "pylsp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(root),
        )
        self._id = 0
        self._lock = threading.Lock()
        self._responses: Dict[Any, Dict[str, Any]] = {}
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self.request(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": to_uri(root),
                "capabilities": {},
                "workspaceFolders": None,
            },
        )
        self.notify("initialized", {})

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                break
            if not line.lower().startswith(b"content-length:"):
                continue
            length = int(line.split(b":", 1)[1].strip())
            while self.proc.stdout.readline().strip():
                pass
            body = self.proc.stdout.read(length)
            if not body:
                break
            try:
                msg = json.loads(body.decode("utf-8"))
            except Exception:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                with self._lock:
                    self._responses[msg["id"]] = msg

    def _write(self, msg: Dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        self.proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
        self.proc.stdin.flush()

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def request(self, method: str, params: Dict[str, Any], timeout: float = 20.0) -> Any:
        with self._lock:
            self._id += 1
            req_id = self._id
        self._write({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                msg = self._responses.pop(req_id, None)
            if msg is not None:
                if "error" in msg:
                    raise RuntimeError(f"LSP {method} failed: {msg['error']}")
                return msg.get("result")
            import time as _t
            _t.sleep(0.01)
        raise TimeoutError(f"LSP {method} timeout")

    def open_document(self, path: Path) -> str:
        uri = to_uri(path)
        text = path.read_text(encoding="utf-8", errors="replace")
        self.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri,
                    "languageId": "python",
                    "version": 1,
                    "text": text,
                }
            },
        )
        return text


class Bridge:
    def __init__(self, root: Path):
        self.root = root
        self.lsp = PylspClient(root)

    def resolve_file(self, args: Dict[str, Any]) -> Optional[Path]:
        raw = str(args.get("file") or args.get("path") or "").strip()
        if raw:
            if raw.startswith("file:///"):
                p = from_uri(raw)
            else:
                p = (self.root / raw).resolve()
            if self.root.resolve() not in p.parents and p != self.root.resolve():
                raise ValueError("文件超出工作目录")
            return p
        query = str(args.get("query") or "").strip()
        if not query:
            return None
        for p in self.root.rglob("*.py"):
            if len(list_args_cache.get("scanned", [])) >= MAX_FILES:
                break
            list_args_cache.setdefault("scanned", []).append(str(p))
            try:
                if p.stat().st_size > MAX_FILE_BYTES:
                    continue
                if query in p.read_text(encoding="utf-8", errors="replace"):
                    return p
            except OSError:
                continue
        return None

    def location(self, item: Dict[str, Any]) -> Dict[str, Any]:
        uri = str(item.get("uri") or "")
        p = from_uri(uri)
        try:
            rel = str(p.resolve().relative_to(self.root.resolve())).replace("\\", "/")
        except ValueError:
            rel = str(p)
        start = item.get("range", {}).get("start", {})
        line0 = int(start.get("line", 0))
        char0 = int(start.get("character", 0))
        preview = ""
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            preview = lines[line0].strip()[:180] if line0 < len(lines) else ""
        except OSError:
            pass
        return {
            "file": rel,
            "line": line0 + 1,
            "character": char0 + 1,
            "preview": preview,
        }

    def scan_symbols(self, query: str, max_results: int) -> List[Dict[str, Any]]:
        """pylsp 默认不实现 workspace/symbol；用轻量文本扫描兜底，至少让符号搜索可用。"""
        import re
        hits: List[Dict[str, Any]] = []
        pattern = re.compile(r"\b(?:def|class)\s+(" + re.escape(query) + r")\b")
        scanned = 0
        for p in self.root.rglob("*.py"):
            scanned += 1
            if scanned > MAX_FILES or len(hits) >= max_results:
                break
            try:
                lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            rel = str(p.resolve().relative_to(self.root.resolve())).replace("\\", "/")
            for idx, line in enumerate(lines):
                m = pattern.search(line)
                if not m:
                    continue
                hits.append({
                    "file": rel,
                    "line": idx + 1,
                    "character": m.start(1) + 1,
                    "preview": line.strip()[:180],
                })
                if len(hits) >= max_results:
                    break
        return hits

    def call(self, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
        list_args_cache.clear()
        op = {
            "lsp_definition": "definition",
            "lsp_references": "references",
            "lsp_hover": "hover",
            "lsp_workspace_symbols": "workspaceSymbol",
        }.get(tool, tool)

        if op == "workspaceSymbol":
            query = str(args.get("query") or "").strip()
            max_results = min(100, max(1, int(args.get("maxResults") or 20)))
            try:
                result = self.lsp.request("workspace/symbol", {"query": query})
                symbols = [self.location(x) for x in (result or [])]
            except RuntimeError as e:
                if "Method Not Found" not in str(e):
                    raise
                symbols = self.scan_symbols(query, max_results)
            symbols = symbols[:max_results]
            return {"operation": op, "count": len(symbols), "symbols": symbols}

        path = self.resolve_file(args)
        if path is None or not path.exists():
            raise ValueError("未找到目标文件；请提供 file 或可定位的 query")
        text = self.lsp.open_document(path)
        query = str(args.get("query") or "").strip()
        pos = args.get("position") if isinstance(args.get("position"), dict) else {}
        if args.get("line") and args.get("character"):
            line0 = max(0, int(args["line"]) - 1)
            char0 = max(0, int(args["character"]) - 1)
        elif pos:
            line0 = max(0, int(pos.get("line", 0)))
            char0 = max(0, int(pos.get("character", 0)))
        elif query:
            offset = text.find(query)
            if offset < 0:
                raise ValueError(f"文件中找不到 query：{query}")
            p = offset_to_position(text, offset)
            line0, char0 = p["line"], p["character"]
        else:
            raise ValueError("需要 line+character 或 query")

        params: Dict[str, Any] = {
            "textDocument": {"uri": to_uri(path)},
            "position": {"line": line0, "character": char0},
        }
        if op == "definition":
            raw = self.lsp.request("textDocument/definition", params)
            items = raw if isinstance(raw, list) else ([raw] if raw else [])
            return {"operation": op, "count": len(items), "symbols": [self.location(x) for x in items]}
        if op == "references":
            params["context"] = {"includeDeclaration": True}
            raw = self.lsp.request("textDocument/references", params)
            items = raw or []
            return {"operation": op, "count": len(items), "symbols": [self.location(x) for x in items]}
        if op == "hover":
            raw = self.lsp.request("textDocument/hover", params) or {}
            contents = raw.get("contents", {})
            value = contents.get("value") if isinstance(contents, dict) else str(contents)
            return {"operation": op, "hover": str(value or "")}
        raise ValueError(f"未知操作：{op}")


list_args_cache: Dict[str, Any] = {}


def tool_definitions() -> List[Dict[str, Any]]:
    schema = {
        "type": "object",
        "properties": {
            "operation": {"type": "string"},
            "query": {"type": "string"},
            "file": {"type": "string"},
            "line": {"type": "integer"},
            "character": {"type": "integer"},
            "language": {"type": "string"},
            "maxResults": {"type": "integer"},
        },
        "required": [],
    }
    annotations = {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False}
    tools = []
    for name, desc in [
        ("lsp_definition", "跳到 Python 符号定义"),
        ("lsp_references", "查找 Python 符号引用"),
        ("lsp_workspace_symbols", "按名字搜索 Python 工作区符号"),
        ("lsp_hover", "查看 Python 符号 hover 文档"),
    ]:
        tools.append({
            "name": name,
            "description": desc,
            "inputSchema": schema,
            "annotations": annotations,
        })
    return tools


def main() -> None:
    root_raw = os.environ.get("MOXIA_WORKSPACE") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not root_raw:
        log("MOXIA_WORKSPACE 未设置，工作目录回退到当前目录")
        root = Path.cwd()
    else:
        root = Path(root_raw)
    bridge: Optional[Bridge] = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            log(f"bad json: {e}")
            continue
        method = msg.get("method")
        req_id = msg.get("id")

        def reply(result: Any) -> None:
            print(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}, ensure_ascii=False), flush=True)

        def fail(code: int, message: str) -> None:
            print(json.dumps({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}, ensure_ascii=False), flush=True)

        try:
            if method == "initialize":
                reply({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO,
                })
            elif method == "notifications/initialized":
                continue
            elif method == "tools/list":
                reply({"tools": tool_definitions()})
            elif method == "tools/call":
                params = msg.get("params") or {}
                name = str(params.get("name") or "")
                args = params.get("arguments") or {}
                if bridge is None:
                    bridge = Bridge(root)
                result = bridge.call(name, args)
                reply({
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "isError": False,
                })
            elif method == "shutdown":
                reply(None)
                break
            else:
                fail(-32601, f"method not found: {method}")
        except Exception as e:
            log(f"tool error: {e}")
            fail(-32000, str(e))


if __name__ == "__main__":
    main()
