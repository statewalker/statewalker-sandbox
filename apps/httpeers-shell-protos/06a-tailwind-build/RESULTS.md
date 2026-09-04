# Prototype 6a — Tailwind build measurements

Tailwind CSS 4.3.3, Basecoat 1.0.2. All figures gzip -9.

| Path | Raw | Gzipped | Build |
|---|---|---|---|
| Tailwind only, content-scanned | 5,526 B | **1,866 B** | 93 ms |
| Tailwind + `@import "basecoat-css"`, content-scanned | 220,163 B | **22,158 B** | 556 ms |
| Basecoat prebuilt `basecoat-base.cdn.min.css` | 90,900 B | **12,153 B** | none |
| Basecoat prebuilt `basecoat-compat.cdn.min.css` | 48,798 B | **5,061 B** | none |
| Basecoat JS `basecoat.min.js` (core) | 2,606 B | **1,108 B** | none |
| Basecoat JS `all.min.js` (all components) | 43,909 B | **10,792 B** | none |

Note: `dist/basecoat.css`, `basecoat-base.css` etc. are @import STUBS
(31-1381 bytes) requiring a Tailwind build. The `.cdn` variants are prebuilt.
