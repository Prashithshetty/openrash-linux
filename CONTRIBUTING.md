# Contributing to OpenRash

Thank you for your interest in contributing to OpenRash!

## Development Setup

1. **Clone repository**:
   ```bash
   git clone https://github.com/Prashithshetty/openrash-linux.git
   cd openrash-linux
   ```

2. **Branching Model**:
   - `main`: Production release branch. All PRs are merged here after review.
   - `develop`: Integration branch for upcoming minor releases.
   - `feature/<name>`: New gameplay features or rendering optimizations.
   - `packaging/<platform>`: Packaging manifests (Flatpak, Snap, AppImage).

3. **Building & Testing**:
   ```bash
   cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
   cmake --build build -j$(nproc)
   ctest --test-dir build --output-on-failure
   ```

## Commit Guidelines

OpenRash adheres to [Conventional Commits](https://www.conventionalcommits.org/):
- `feat(...)`: New features
- `fix(...)`: Bug fixes
- `docs(...)`: Documentation updates
- `test(...)`: Unit and integration test additions
- `refactor(...)`: Code cleanup with no behavior changes
