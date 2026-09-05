# On the Map

A static, backend-free page that turns any pasted map image into a live navigation map.

1. **Add a map image** – paste (Ctrl+V), drag & drop, or choose a file.
2. **Mark known points** – tap two (or more) spots on your image. For each one, find the same spot on the
   OpenStreetMap picker inside the dialog and tap it (drag the pin to refine), or type `lat, lon` / paste a
   Google Maps link, or use your current GPS position. From the third point on, the picker opens on an
   estimate derived from the points you already have. Drag an image marker to fine-tune it, tap it to edit.
   Extra points improve the fit; the list shows each point's residual error.
3. **Navigate** – your GPS position, accuracy circle and heading are drawn on the image. Pan and pinch-zoom
   freely; the ⦿ button re-centres on you. The **N / ▲** button switches between *north up* (the image is
   rotated so geographic north is at the top; unchanged for a north-up image) and *heading up* (the image
   rotates so the direction you are facing is at the top). Heading comes from the device compass when the
   browser provides one (iOS asks for permission on the first tap), otherwise from GPS course while moving.

Everything is stored in the browser only: the image in IndexedDB, the points and current step in localStorage.
The only external resources are Leaflet (from cdnjs) and OpenStreetMap tiles for the picker; navigation itself
works offline once the page is loaded.

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
