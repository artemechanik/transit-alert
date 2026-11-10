# Lucide icons for planner autocomplete

Source: https://github.com/lucide-icons/lucide/tree/6f61f73a91ef34fc661e12ba8d0107f8ec4e4820/icons

Revision: 6f61f73a91ef34fc661e12ba8d0107f8ec4e4820. Original SVG files; monochrome CSS masks using current theme color.
License: ISC plus upstream Feather notices, see the complete LICENSE. No runtime CDN. Scoped to typed results in Trasa from/to fields.

`poi-icons.js` contains 11 movie_theater POI IDs from the local catalog plus BDOT
bus-station / Overture airport exceptions. The API exposes only broad categories;
this local ID mapping prevents guessing a cinema or station type from name words.
It is a static presentation resource; it neither changes the catalog nor queries it
at runtime. Refresh exceptions consciously when importing a different POI snapshot.
Other category mappings are in the typed-autocomplete renderer only.
