import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Wraps an Omni Automation snippet so it runs as a function body with its
 * arguments in scope as `args`. Values are embedded as a JSON literal, so
 * quotes and newlines in task names need no escaping of our own.
 */
export function buildSource(body: string, args: unknown): string {
  return `(() => { const args = ${JSON.stringify(args)};\n${body}\n})()`;
}

/**
 * Runs an Omni Automation snippet inside OmniFocus and parses its JSON result.
 * The snippet must end by returning a JSON string.
 */
export async function runOmniJS<T>(body: string, args: unknown = {}): Promise<T> {
  const source = buildSource(body, args);
  // JXA hands the snippet to OmniFocus; whatever it returns comes back as a string.
  const jxa = `Application('OmniFocus').evaluateJavascript(${JSON.stringify(source)})`;
  // The snippet travels as one command-line argument, so it has to stay under ARG_MAX.
  if (jxa.length > 256 * 1024) {
    throw new Error("Too much text for one call — shorten the note or ask for fewer results.");
  }
  try {
    const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", jxa], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new Error(explain(err));
  }
}

/**
 * Turns an osascript failure into something a person can act on. Apple error
 * codes are matched in their parenthesised form, so a task named "not running"
 * can't talk us into the wrong diagnosis.
 */
export function explain(err: unknown): string {
  const text = String(
    (err as { stderr?: string }).stderr || (err as Error).message || err,
  ).trim();
  if ((err as { code?: string }).code === "ENOENT") {
    return "osascript not found — this server only runs on macOS.";
  }
  if (text.includes("(-1743)")) {
    return "macOS blocked automation. Allow your MCP client to control OmniFocus under System Settings > Privacy & Security > Automation.";
  }
  if (text.includes("(-600)")) return "OmniFocus is not running. Open it and try again.";
  if (text.includes("(-1708)")) {
    return "OmniFocus rejected the script. Omni Automation needs OmniFocus Pro.";
  }
  return text || "The OmniFocus script failed.";
}
