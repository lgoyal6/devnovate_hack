/**
 * Serves the mock run over the real HTTP surface so Bryan can build the entire
 * interface against a live stream before any of it exists.
 *
 *   pnpm mock:serve
 *   curl -N 'http://localhost:4000/api/runs/mock-run-001/events?speed=6'
 *   curl -s  http://localhost:4000/api/runs/mock-run-001 | jq
 *   curl -s  http://localhost:4000/api/rules | jq
 *
 * This is a stand-in for the Next.js routes in apps/control, not a second
 * implementation of them: it serves the same paths and the same shapes.
 * Integration means pointing the UI at the real port and deleting this file.
 */
import { createServer } from "node:http";
import { env } from "../src/lib/env.js";
import { MOCK_RULES, buildMockRun, streamMockRun } from "../src/mock-run.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${env.CONTROL_PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS).end();
    return;
  }

  const json = (status: number, body: unknown) => {
    res.writeHead(status, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/rules") {
    json(200, MOCK_RULES);
    return;
  }

  const streamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (streamMatch) {
    const runId = decodeURIComponent(streamMatch[1] ?? "");
    const speed = Number(url.searchParams.get("speed") ?? "1");

    res.writeHead(200, {
      ...CORS,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let open = true;
    req.on("close", () => {
      open = false;
    });

    try {
      for await (const event of streamMockRun(runId, {
        speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
      })) {
        if (!open) break;
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      // Surface it on the stream and in the log. A stream that dies silently
      // looks identical to a run that finished, which is the worst failure mode
      // for whoever is debugging the UI at 3am.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mock-sse] stream for ${runId} failed:`, error);
      if (open) res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    }

    if (open) res.end();
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1] ?? "");
    json(200, buildMockRun(runId, 0).snapshot);
    return;
  }

  json(404, { error: "not_found", path: url.pathname });
});

server.listen(env.CONTROL_PORT, () => {
  const base = `http://localhost:${env.CONTROL_PORT}`;
  console.log(`mock control plane on ${base}`);
  console.log(`  GET ${base}/api/rules`);
  console.log(`  GET ${base}/api/runs/mock-run-001`);
  console.log(`  GET ${base}/api/runs/mock-run-001/events?speed=6   (SSE)`);
});
