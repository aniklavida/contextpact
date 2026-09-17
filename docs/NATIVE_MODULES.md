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
4. **Engine floor verification:** CI tests on the declared Node floor (`22.12.0`) and proves that versions below the floor (such as Node 20) are refused by engine-strict installation and CLI execution.
