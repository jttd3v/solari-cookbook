"""Demo target for Preflight — a tiny to-do app with FOUR planted bugs.

Pure stdlib so it runs on the `base` sandbox template with zero installs.
State lives in memory; restart the process to reset it.

Planted bugs (don't fix these — Preflight is supposed to find them):
  1. POST /api/todos accepts an empty title.
  2. DELETE /api/todos/<id> deletes the item BEFORE the one you asked for.
  3. "Clear completed" calls a route that doesn't exist → 404 + a JS TypeError.
  4. The "items left" counter counts every item, not just the open ones.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TODOS = [
    {"id": 1, "title": "Buy milk", "done": False},
    {"id": 2, "title": "Write report", "done": True},
    {"id": 3, "title": "Call the harbour master", "done": False},
]
NEXT_ID = 4

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tidelist — demo to-do app</title>
<style>
  body { font: 16px/1.4 system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 16px; color: #1c1c1c; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #666; margin: 0 0 20px; font-size: 14px; }
  form { display: flex; gap: 8px; margin-bottom: 16px; }
  input[type=text] { flex: 1; padding: 8px 10px; font-size: 16px; border: 1px solid #bbb; border-radius: 6px; }
  button { padding: 8px 12px; font-size: 14px; border: 1px solid #888; background: #f6f6f6; border-radius: 6px; cursor: pointer; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #eee; }
  li.done .title { text-decoration: line-through; color: #999; }
  .title { flex: 1; }
  footer { display: flex; justify-content: space-between; margin-top: 14px; font-size: 14px; color: #555; }
</style>
</head>
<body>
  <h1>Tidelist</h1>
  <p class="sub">A deliberately buggy to-do app. Preflight's job is to find out how buggy.</p>

  <form id="add-form">
    <input id="new-title" type="text" placeholder="What needs doing?" aria-label="New to-do title">
    <button type="submit" id="add-btn">Add</button>
  </form>

  <ul id="list" aria-label="To-do list"></ul>

  <footer>
    <span id="count" aria-live="polite"></span>
    <button id="clear-done">Clear completed</button>
  </footer>

<script>
  const $ = (s) => document.querySelector(s);

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  function render(todos) {
    const ul = $("#list");
    ul.innerHTML = "";
    for (const t of todos) {
      const li = document.createElement("li");
      li.className = t.done ? "done" : "";
      li.dataset.id = t.id;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = t.done;
      cb.setAttribute("aria-label", "Mark '" + t.title + "' " + (t.done ? "not done" : "done"));
      cb.addEventListener("change", async () => render(await api("POST", "/api/todos/" + t.id + "/toggle")));

      const span = document.createElement("span");
      span.className = "title";
      span.textContent = t.title;

      const del = document.createElement("button");
      del.textContent = "Delete";
      del.setAttribute("aria-label", "Delete '" + t.title + "'");
      del.addEventListener("click", async () => render(await api("DELETE", "/api/todos/" + t.id)));

      li.append(cb, span, del);
      ul.append(li);
    }
    // BUG 4: should count only the open items.
    $("#count").textContent = todos.length + " items left";
  }

  $("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#new-title").value;
    render(await api("POST", "/api/todos", { title }));
    $("#new-title").value = "";
  });

  $("#clear-done").addEventListener("click", async () => {
    // BUG 3: this route does not exist on the server.
    const todos = await api("POST", "/api/todos/clear");
    render(todos.items);
  });

  api("GET", "/api/todos").then(render);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/":
            return self._html(PAGE)
        if self.path == "/api/todos":
            return self._json(200, TODOS)
        if self.path == "/healthz":
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        global NEXT_ID
        if self.path == "/api/todos":
            title = self._read_json().get("title", "")
            # BUG 1: no validation — an empty or whitespace title is accepted.
            TODOS.append({"id": NEXT_ID, "title": title, "done": False})
            NEXT_ID += 1
            return self._json(200, TODOS)
        if self.path.startswith("/api/todos/") and self.path.endswith("/toggle"):
            tid = int(self.path.split("/")[3])
            for t in TODOS:
                if t["id"] == tid:
                    t["done"] = not t["done"]
            return self._json(200, TODOS)
        return self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if self.path.startswith("/api/todos/"):
            tid = int(self.path.split("/")[3])
            idx = next((i for i, t in enumerate(TODOS) if t["id"] == tid), None)
            if idx is not None:
                # BUG 2: off-by-one — removes the item before the requested one
                # (or the first item when you delete the first).
                del TODOS[max(idx - 1, 0)]
            return self._json(200, TODOS)
        return self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8000))
    # Bind to all interfaces so the sandbox's preview proxy can reach it.
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"tidelist listening on :{port}", flush=True)
    server.serve_forever()
