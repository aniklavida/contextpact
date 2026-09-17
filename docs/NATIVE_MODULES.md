# Native module packaging and platform requirements

ContextPact uses `better-sqlite3` (MIT licensed) for local operational storage, task leasing, and FTS5 search indexing. `better-sqlite3` is a C++ Node-API native addon.

## Prebuilt binaries and source compilation

`better-sqlite3` distributes prebuilt binaries compiled against Node-API version 10 for the following platform and architecture targets:

- macOS ARM64 (`darwin-arm64.node`)
- macOS x64 (`darwin-x64.node`)
- Linux x64 glibc (`linux-x64.node`)
- Linux ARM64 glibc (`linux-arm64.node`)
- Linux x64 musl (`linuxmusl-x64.node`)
- Linux ARM64 musl (`linuxmusl-arm64.node`)
- Windows x64 (`win32-x64.node`)
- Windows ARM64 (`win32-arm64.node`)

### Resolution path

1. **Prebuilt binary path (standard):** During `npm install`, `better-sqlite3` executes `lib/binding.js` to detect whether a prebuilt binary exists for `process.platform` and `process.arch`. If present, `binding.gyp` sets the build target to `none` and skips compiler invocation. At runtime, the prebuilt addon is loaded directly.
2. **Source build fallback:** If no prebuilt binary is available (for example, on unsupported architectures or operating systems such as FreeBSD, or when explicitly requested via `--build-from-source`), `better-sqlite3` falls back to `node-gyp rebuild` and compiles SQLite and C++ bindings from source.

## Fallback prerequisites

When the source build fallback fires, `node-gyp` requires a C++20 compliant compiler toolchain and Python 3:

### Windows

- Python 3 (`python --version`)
- Visual Studio Build Tools 2019 or 2022 with the "Desktop development with C++" workload (MSVC compiler supporting `/std:c++20`).
- Ensure Windows SDK is included in the build tools installation.

### macOS

- Apple Xcode Command Line Tools (`xcode-select --install`), providing Clang with `-std=c++20` and `-stdlib=libc++`.
- Python 3 (installed with Xcode CLI tools or Homebrew).

### Linux

- Python 3 (`python3`)
- GCC 10+ or Clang 10+ with C++20 support and `make`:
  - Debian/Ubuntu: `sudo apt-get install -y build-essential python3`
  - Fedora/RHEL: `sudo dnf groupinstall -y "Development Tools" && sudo dnf install -y python3`
  - Alpine Linux: `apk add --no-cache make gcc g++ python3`

## Filesystem and SQLite WAL behavior across platforms

ContextPact configures SQLite in Write-Ahead Logging mode (`PRAGMA journal_mode = WAL`) and `PRAGMA synchronous = NORMAL`.

- **macOS and Linux:** SQLite WAL uses shared memory through POSIX memory-mapping APIs (`-shm` and `-wal` auxiliary files). File deletion semantics allow unlinking open files from directories.
- **Windows (NTFS/ReFS):**
  - Windows enforces byte-range locking and prevents unlinking (`unlinkSync`) or renaming (`renameSync`) files that are open in any process (`EBUSY` / `EPERM`). ContextPact ensures all database connections are explicitly closed before workspace deletions, backups, or restore operations.
  - SQLite WAL requires shared memory primitives (`CreateFileMapping`). WAL mode does not function over network-attached filesystems (SMB, UNC network paths) because memory mappings cannot be shared across machines. On local Windows drives, WAL mode functions normally.

## Continuous integration verification

ContextPact validates cross-platform packaging and clean installation in CI:

1. **Matrix validation:** The test suite and clean installation runs across `ubuntu-latest`, `macos-latest`, and `windows-latest`.
2. **Clean-install isolation:** A packed package tarball (`npm pack`) is installed into an empty directory outside the repository checkout, proving runtime operation without `devDependencies` or source files.
3. **Native module diagnostics:** CI inspects `better-sqlite3` in both repository checkouts and clean installs, logging whether a prebuilt binary or source compilation was utilized.
4. **Engine floor verification:** CI runs the whole suite on the declared Node floor (`22.14.0`) and proves that versions below the floor (such as Node 20) are refused by engine-strict installation and CLI execution.

## Observed on the first matrix run — Windows install fails

The first run of the cross-platform matrix failed to install on `windows-latest`, and the detail matters because it is not the failure this document anticipated.

**`better-sqlite3` 13.0.3 ships its prebuilt binaries inside the npm tarball**, not as GitHub release assets. The installed tree contains all eight, `win32-x64.node` among them:

```
prebuilds/darwin-arm64.node   prebuilds/linuxmusl-arm64.node
prebuilds/darwin-x64.node     prebuilds/linuxmusl-x64.node
prebuilds/linux-arm64.node    prebuilds/win32-arm64.node
prebuilds/linux-x64.node      prebuilds/win32-x64.node
```

So the Windows binary was present and no compilation should have been needed. `npm ci` invoked `node-gyp rebuild` anyway, and it failed — not for want of a compiler, but because node-gyp did not recognise the Visual Studio on the runner image:

```
gyp ERR! find VS unknown version "undefined" found at
         "C:\Program Files\Microsoft Visual Studio\18\Enterprise"
gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use
```

The same run also produced `EPERM: operation not permitted, rmdir` while npm cleaned up `node_modules`, which is the Windows file-locking behaviour described above, observed rather than predicted.

**What is not yet known.** Whether this is specific to the current GitHub runner image — Visual Studio 18 is newer than the node-gyp release in use can identify — or whether an ordinary Windows user hits it too. Those have different answers: the first is a CI environment problem, the second is a product one, and this document must not guess between them.

**What is therefore claimed.** Nothing about Windows. The matrix cell stays failing and visible rather than pinned around, skipped, or quietly excluded until it looks green. A red cell that names its cause is worth more than a green one that was arranged.

Tracked as [issue #17](https://github.com/aniklavida/contextpact/issues/17), which records what would settle the question: reproducing an install on a Windows host outside GitHub Actions.

## Observed on the first matrix run — the declared Node floor did not work

The same run failed the `node-floor` job, and this one was not an environment
question. It was answered.

The floor was `22.12.0`, chosen because it is the oldest Node 22 LTS. On that
version `vitest` died with `Segmentation fault (core dumped)` before naming a
single test file. It reproduces on macOS arm64 as well as the Linux runner, so
it is the Node version, not the platform.

Narrowed to one call:

| Step                        | 22.12.0     | 22.13.0     | 22.14.0 | 22.16.0 |
| --------------------------- | ----------- | ----------- | ------- | ------- |
| `require("better-sqlite3")` | ok          | ok          | ok      | ok      |
| `new Database(":memory:")`  | **SIGSEGV** | **SIGSEGV** | ok      | ok      |
| `npm run check` (202 tests) | SIGSEGV     | SIGSEGV     | passes  | passes  |

So it is not the test runner. Opening a database — the first thing any real
command does — crashes the process. `contextpact --help` still works on
22.12.0, which is exactly how a floor this wrong survives casual checking.

`better-sqlite3` 13.0.3 declares `engines: { "node": ">=22" }`. That claim does
not hold: 22.12.0 and 22.13.0 satisfy it and segfault.

**What is therefore claimed.** The floor is now `22.14.0`, the oldest version
the suite has actually been run on. It is declared in `package.json`, enforced
at runtime by `assertSupportedNodeVersion`, and exercised by CI at exactly that
version. A test asserts the constant and the `engines` range still agree, and
another asserts 22.12.0 and 22.13.0 are refused, so lowering the floor back
cannot pass quietly.

This is the opposite decision from the Windows cell above, for the opposite
reason: there the cause is unknown, so nothing is claimed; here the cause is
known, so the wrong claim is corrected.
