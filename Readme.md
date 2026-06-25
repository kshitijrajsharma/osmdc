# OSM Completeness Helper

Drop a GeoJSON polygon and see how complete OpenStreetMap is inside it. The area is
split into H3 hexagons, each coloured by how much of what Overture Maps knows about,
buildings and roads, already carries an OpenStreetMap source. Low values are mapping
gaps.

It is a static browser app. Hexagon tiles are pre-built for the whole planet and read
straight from a Hugging Face dataset with DuckDB-WASM, so there is no backend.

## Develop

```
just setup    # install dependencies
just serve    # run the app at http://localhost:8000
just test     # run tests
```

Built with ❤️ by [kshitij](https://github.com/sponsors/kshitijrajsharma).
