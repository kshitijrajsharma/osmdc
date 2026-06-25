set shell := ["bash", "-cu"]

# Install dependencies
setup:
    uv sync

# Lint, format-check and type-check
lint:
    uv run ruff check .
    uv run ruff format --check .
    uv run ty check

# Run tests
test:
    uv run pytest -q

# Aggregate one area, e.g.: just tile "85.20 27.60 85.45 27.80" out/kathmandu
tile bbox out:
    uv run osmdc --bbox {{bbox}} --out {{out}}

# Serve the browser app at http://localhost:8000
serve:
    cd web && python3 -m http.server 8000
