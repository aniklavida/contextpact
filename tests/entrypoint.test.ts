import { describe, expect, it } from "vitest";
import { isEntrypointPath } from "../src/cli";

// Windows reports process.argv[1] with backslashes. A suffix check against
// forward-slash paths therefore never matched there, so the CLI loaded, decided
// it had not been invoked as a command, and exited silently — no output, no
// error, no exit code to notice. These are the real argv[1] shapes each
// platform produces, asserted on any platform.
describe("entrypoint detection across path separators", () => {
  const moduleUrlPath = "/repo/dist/cli.js";

  const invoked: Array<[string, string]> = [
    [
      "windows, installed binary",
      "C:\\project\\node_modules\\.bin\\contextpact",
    ],
    ["windows, .cmd shim", "C:\\project\\node_modules\\.bin\\contextpact.cmd"],
    ["windows, built file", "C:\\project\\dist\\cli.js"],
    ["windows, source file", "C:\\project\\src\\cli.ts"],
    ["posix, installed binary", "/project/node_modules/.bin/contextpact"],
    ["posix, built file", "/project/dist/cli.js"],
    ["posix, source file", "/project/src/cli.ts"],
  ];

  for (const [name, argv1] of invoked) {
    it(`treats ${name} as an invocation`, () => {
      expect(isEntrypointPath(argv1, moduleUrlPath)).toBe(true);
    });
  }

  const notInvoked: Array<[string, string | undefined]> = [
    ["nothing at all", undefined],
    ["a different program", "/usr/local/bin/vitest"],
    ["a windows program that merely ends in .cmd", "C:\\tools\\other.cmd"],
    ["a file whose name only contains cli", "/project/dist/clients.js"],
  ];

  for (const [name, argv1] of notInvoked) {
    it(`does not treat ${name} as an invocation`, () => {
      expect(isEntrypointPath(argv1, moduleUrlPath)).toBe(false);
    });
  }

  it("matches when argv[1] is the module's own resolved path", () => {
    expect(isEntrypointPath(moduleUrlPath, moduleUrlPath)).toBe(true);
  });
});
