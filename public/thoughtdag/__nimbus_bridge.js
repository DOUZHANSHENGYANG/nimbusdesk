/* Injected into the ThoughtDAG dist served by the workbench.
   It gives ThoughtDAG the small `window.desktop` surface it probes for, and
   forwards the file primitives to the Tauri host through postMessage. */
(() => {
  // The bridge only makes sense inside the workbench's iframe. A standalone
  // browser tab (the "open externally" path) keeps ThoughtDAG's own fallbacks.
  if (window.parent === window) return;
  if (window.desktop && window.desktop.sessions) return;
  let seq = 0;
  const pending = new Map();
  const streams = new Map();
  let parentOrigin = "*";
  try {
    if (document.referrer) parentOrigin = new URL(document.referrer).origin;
  } catch {
    parentOrigin = "*";
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data) return;
    if (data.__nimbusStream === true) {
      const stream = streams.get(data.id);
      if (!stream) return;
      if (data.done) {
        streams.delete(data.id);
        try { stream.close(); } catch { /* already closed */ }
      } else if (data.error) {
        streams.delete(data.id);
        try { stream.error(new Error(data.error)); } catch { /* already errored */ }
      } else if (data.text) {
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text: data.text })}\n\n`));
      }
      return;
    }
    if (data.__nimbusResult !== true) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.data);
    else entry.reject(new Error(data.error || "bridge error"));
  });
  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const id = String(++seq);
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ __nimbus: true, id, method, args: args || {} }, parentOrigin);
    });
  const sessions = {
    roots: () => call("sessions.roots"),
    addRoot: async () => null,
    removeRoot: async () => undefined,
    list: (rootKey) => call("sessions.list", { rootKey }),
    head: (rootKey, rel, bytes) => call("sessions.head", { rootKey, rel, bytes }),
    read: (rootKey, rel) => call("sessions.read", { rootKey, rel }),
    readRange: (rootKey, rel, start, length) => call("sessions.readRange", { rootKey, rel, start, length }),
    openInCli: async () => ({ opened: false, via: "", command: "" }),
    openTargets: async () => ({ terminals: [], apps: [], prefs: { terminal: "" }, canAddCustom: false }),
    setOpenPrefs: async () => ({ terminal: "" }),
    addTerminal: async () => null,
  };
  // Route model list + chat through the workbench provider store. ThoughtDAG's
  // own proxy stays the fallback for everything else.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/api/models")) {
      const data = await call("models.list");
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/stream") && init && init.body) {
      const body = JSON.parse(String(init.body));
      const id = String(++seq);
      const stream = new ReadableStream({
        start(controller) {
          streams.set(id, controller);
          window.parent.postMessage(
            { __nimbus: true, id, method: "chat.stream", args: { messages: body.messages || [], model: body.model } },
            parentOrigin,
          );
        },
        cancel() {
          streams.delete(id);
          window.parent.postMessage({ __nimbusCancel: true, id }, parentOrigin);
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    // Optional ThoughtDAG endpoints that the embedded host does not own.
    // Return structured JSON instead of an opaque asset-server 404.
    if (url.includes("/api/runtime-providers")) {
      return new Response(JSON.stringify({ providers: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/permission-modes")) {
      return new Response(JSON.stringify({ modes: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/approvals")) {
      return new Response(JSON.stringify({ approvals: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/probe-models")) {
      const data = await call("models.list");
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/fetch-url") || url.includes("/api/pdf-extract") || url.includes("/api/claude")) {
      return new Response(JSON.stringify({ error: "This endpoint is not available in the embedded canvas" }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Any other ThoughtDAG endpoint the host doesn't implement: answer with a
    // readable JSON 501 instead of letting the asset server return HTML/404.
    if (url.includes("/api/")) {
      return new Response(
        JSON.stringify({ error: `This endpoint is not available in the embedded canvas: ${url}` }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input, init);
  };

  window.desktop = {
    checkForUpdates: async () => undefined,
    downloadUpdate: async () => undefined,
    installUpdate: async () => undefined,
    tray: async () => ({ closeToTray: false }),
    sessions,
    local: { open: async () => undefined, image: async () => null },
  };
})();
