import type {
  CandidateId,
  CorpusInput,
  RawResult,
} from "@intentguard/contracts";
import { emitEvent } from "@intentguard/control/events";

export const REPLAY_TIMEOUT_MS = 5_000;

type ReplayErrorContext = {
  runId: string;
  candidateId: CandidateId;
  inputId: string;
  url: string;
  cause: unknown;
};

export class ReplayRequestError extends Error {
  readonly runId: string;
  readonly candidateId: CandidateId;
  readonly inputId: string;
  readonly url: string;

  constructor(message: string, context: ReplayErrorContext) {
    super(message, { cause: context.cause });
    this.name = "ReplayRequestError";
    this.runId = context.runId;
    this.candidateId = context.candidateId;
    this.inputId = context.inputId;
    this.url = context.url;
  }
}

function resolvePreviewUrl(previewUrl: string, input: CorpusInput): URL {
  const url = new URL(input.path, previewUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`unsupported preview protocol ${url.protocol}`);
  }

  return url;
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

async function readBody(response: Response): Promise<unknown> {
  const body = await response.text();

  if (!isJsonContentType(response.headers.get("content-type")) || body === "") {
    return body;
  }

  const parsed: unknown = JSON.parse(body);
  return parsed;
}

async function replayInput(
  runId: string,
  previewUrl: string,
  input: CorpusInput,
  candidateId: CandidateId,
): Promise<RawResult> {
  let url: URL;

  try {
    url = resolvePreviewUrl(previewUrl, input);
  } catch (cause: unknown) {
    throw new ReplayRequestError(
      `Replay failed for run ${JSON.stringify(runId)}, candidate ${candidateId}, input ${input.id}: invalid preview URL or path`,
      {
        runId,
        candidateId,
        inputId: input.id,
        url: `${previewUrl}${input.path}`,
        cause,
      },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const init: RequestInit = {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      signal: controller.signal,
      ...(input.method === "POST" ? { body: JSON.stringify(input.payload) } : {}),
    };
    const response = await fetch(url, init);
    const body = await readBody(response);

    return {
      candidateId,
      inputId: input.id,
      status: response.status,
      body,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (cause: unknown) {
    const detail = controller.signal.aborted
      ? `timed out after ${REPLAY_TIMEOUT_MS}ms`
      : "request failed";

    throw new ReplayRequestError(
      `Replay ${detail} for run ${JSON.stringify(runId)}, candidate ${candidateId}, input ${input.id}, URL ${url.toString()}`,
      {
        runId,
        candidateId,
        inputId: input.id,
        url: url.toString(),
        cause,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Replays inputs in corpus order and returns transport observations only.
 * HTTP failures remain results; network, timeout, and body-read failures throw
 * with candidate/input context. No business or comparison logic is applied.
 */
export async function replay(
  runId: string,
  previewUrl: string,
  corpus: CorpusInput[],
  candidateId: CandidateId,
): Promise<RawResult[]> {
  const results: RawResult[] = [];

  for (const input of corpus) {
    results.push(await replayInput(runId, previewUrl, input, candidateId));
  }

  emitEvent(runId, {
    source: "control",
    type: "CORPUS_REPLAYED",
    candidateId,
    message: `Replayed ${String(results.length)} corpus inputs against ${candidateId}.`,
    payload: { results },
  });

  return results;
}
