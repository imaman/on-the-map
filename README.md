# On the Map

A static, backend-free page that turns any pasted map image into a live navigation map.

1. **Add a map image** – paste (Ctrl+V), drag & drop, or choose a file.
2. **Mark known points** – tap two (or more) spots whose real-world coordinates you know and type them in
   (decimal `lat, lon`, or paste a Google Maps link). Drag a marker to fine-tune it, tap it to edit.
   Extra points improve the fit; the list shows each point's residual error.
3. **Navigate** – your GPS position, accuracy circle and heading are drawn on the image. Pan and pinch-zoom
   freely; the ⦿ button re-centres on you.

Everything is stored in the browser only: the image in IndexedDB, the points and current step in localStorage.

## Running

The page needs a secure context for geolocation, so serve it over **HTTPS or localhost**, e.g.

```sh
npx serve .            # or: python3 -m http.server
```

or host the three files (`index.html`, `styles.css`, `app.js`) on GitHub Pages / Netlify / any static host.

## How the mapping works

Known points are projected to Web Mercator and a least-squares similarity transform
(scale + rotation + translation) is fitted between world and image pixel coordinates.
Two points define it exactly; more points are averaged.
