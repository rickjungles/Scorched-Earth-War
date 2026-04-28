# Sky Module Integration Brief

This brief is for Claude Code, which will integrate the `sky.js` module into an existing browser-based Scorched Earth clone (HTML5 Canvas + JavaScript, hosted on GitHub Pages).

## What sky.js provides

A single `Sky` class that draws a dynamic time-of-day + weather-aware sky onto a canvas. Features:

- **Time-of-day gradient** — interpolates a 7-stop palette (night → pre-dawn → sunrise → morning → day → afternoon → sunset → dusk → night) using real sunrise/sunset times.
- **Sun and moon** that travel across the sky on an arc, with sun shifting orange near the horizon. Moon has craters and a soft halo.
- **Twinkling stars** that fade in/out around dusk and dawn. Density scales with canvas size.
- **Procedurally generated clouds** using noise-displacement (the canvas equivalent of SVG `feTurbulence` + `feDisplacementMap`). Three cloud types: puffy cumulus, stretched stratocumulus, wispy cirrus.
- **Sun occlusion** — when clouds drift in front of the sun, the sky dims and individual clouds blocking the sun get visibly denser/darker (real backlit cloud behavior).
- **Optional weather fetch** from Open-Meteo (free, keyless, CORS-friendly) for live cloud cover and accurate sunrise/sunset for the player's location.

## Public API

```javascript
const sky = new Sky({
    lat: 44.55,             // for weather + sun times (default: Howard, WI)
    lon: -88.05,
    useWeather: true,       // fetch live weather from Open-Meteo
    useRealSunTimes: true,  // use actual sunrise/sunset for that day
});

// Override controls (set null to use real values)
sky.timeOverride = 14;        // decimal hour, 0-24
sky.cloudOverride = 50;       // percent, 0-100

// Public getters
sky.getCurrentHour();         // returns current hour (override or system clock)
sky.getCurrentCloudCover();   // returns current cloud %

// In your render loop:
sky.update(timestamp);        // updates weather, animates clouds
sky.draw(ctx, timestamp);     // draws everything (call FIRST, before terrain/tanks/etc.)
```

The `update` method handles weather refresh internally (rate-limited to once per 30 min). A failed fetch logs once and falls back to defaults — never blocks rendering.

## Integration steps

### 1. Add sky.js to your project

Drop `sky.js` next to your existing JS files. Add a script tag in your HTML before your main game script:

```html
<script src="sky.js"></script>
<script src="game.js"></script>
```

### 2. Instantiate at game start

When the game starts up (NOT per round), create one Sky instance. Weather fetches once at game start and caches.

```javascript
// At game initialization
const sky = new Sky({
    lat: 44.55,
    lon: -88.05,
    useWeather: true,
});
```

### 3. Apply per-round settings

At the start of each round, apply the player's menu choices:

```javascript
function applyRoundSky(timeChoice, cloudChoice) {
    // Time
    if (timeChoice === 'local')   sky.timeOverride = null;
    else if (timeChoice === 'dawn')    sky.timeOverride = sky.sunrise - 0.5;
    else if (timeChoice === 'sunrise') sky.timeOverride = sky.sunrise + 0.3;
    else if (timeChoice === 'noon')    sky.timeOverride = 12;
    else if (timeChoice === 'sunset')  sky.timeOverride = sky.sunset - 0.2;
    else if (timeChoice === 'night')   sky.timeOverride = 22;
    else if (timeChoice === 'random')  sky.timeOverride = Math.random() * 24;

    // Cloud cover
    if (cloudChoice === 'local')      sky.cloudOverride = null;
    else if (cloudChoice === 'random') sky.cloudOverride = Math.floor(Math.random() * 101);
    else                               sky.cloudOverride = parseInt(cloudChoice, 10);
}
```

Note: dawn/sunrise/sunset offsets are anchored to `sky.sunrise` and `sky.sunset`, which come from Open-Meteo if available (otherwise default to 6.5 / 19.5). This means "Sunrise" looks correct year-round in Wisconsin, not just summer.

### 4. Wind drives cloud speed

The game's wind is normalized as MPH in range 0-100. Add a method call at the start of each round to set wind for the duration:

```javascript
sky.setWindSpeed(currentWind);  // -100 to +100 (negative = west wind, blows clouds left)
```

You'll need to **add this method to sky.js** — see "Required additions" section below.

### 5. Render order

In your game loop, draw the sky FIRST, then everything else on top:

```javascript
function render(timestamp) {
    sky.update(timestamp);
    sky.draw(ctx, timestamp);
    drawTerrain();
    drawTanks();
    drawProjectiles();
    drawHUD();
    requestAnimationFrame(render);
}
```

## Required additions to sky.js

Two additions Claude Code needs to make:

### A. setWindSpeed(mph)

The game's wind is the player-facing scalar in MPH (-100 to +100). Wind affects projectile drift in the game; we want it to also drift the clouds.

Each cloud has `c.speed` set at creation (currently `0.04 + Math.random() * 0.1`, drifting right at all times). We need to (a) modulate this with the round's wind value, (b) preserve per-cloud variation, and (c) handle leftward drift (wind goes negative).

Implementation:

```javascript
// Add as a method on the Sky class
setWindSpeed(mph) {
    // Each cloud already has a baseSpeed (set at creation).
    // Map game wind 0-100 mph to a sensible cloud drift.
    // 0 mph = barely drifting (each cloud at its random base speed in original direction)
    // 100 mph = clouds visibly hauling
    const windFactor = mph / 60;  // 60 mph wind feels appropriate at ~1x base speed
    for (const c of this.clouds) {
        if (c.baseSpeed === undefined) c.baseSpeed = c.speed;
        c.speed = (c.baseSpeed + Math.abs(windFactor) * 0.4) * Math.sign(windFactor || 1);
    }
    this._windDirection = windFactor < 0 ? -1 : 1;
}
```

**Important — leftward drift**: The current `_drawClouds` only handles rightward wraparound (`if (c.x > this.lastWidth) c.x = -c.bmpW`). Update it to handle both directions:

```javascript
// In _drawClouds, replace the wraparound logic:
if (this._windDirection === -1) {
    if (c.x + c.bmpW < 0) c.x = this.lastWidth;
} else {
    if (c.x > this.lastWidth) c.x = -c.bmpW;
}
```

Also, when new clouds are spawned via `_makeCloud(true)` mid-round, they currently start at `Math.random() * w` which is fine for either direction. But for the off-screen spawn case (`_makeCloud(false)`), the position should depend on wind direction — start them on the right edge if wind is leftward.

### B. Re-fetch protection

The current `fetchWeather()` rate-limits to 30 min. Since the brief is "fetch once at game start," that's already correct — but verify by setting `sky.weatherFetchInterval = Infinity` after the first successful fetch if you want absolute certainty no second fetch happens.

## Menu integration

Add two new menu items to the existing match setup menu, matching the existing menu's classic style (whatever yellow-on-black / cyan / arrow-key-driven style the game already uses).

### Menu items

**Time of Day**
- Local
- Dawn
- Sunrise
- Noon
- Sunset
- Night
- Random

**Cloud Cover**
- Local
- 20%
- 50%
- 80%
- 100%
- Random

The default for both should be "Local" — preserves the existing experience for players who don't touch the new options.

### Persistence

Save the player's last selection to localStorage so it persists across game sessions, consistent with however the existing menu handles other settings.

## Failure handling

The Open-Meteo fetch can fail for several reasons:

- Player is offline.
- Player opened the game from `file://` (browsers block fetch from `file://` origins). The module already detects this and skips silently — no warning needed.
- Open-Meteo is down or rate-limiting.

In all failure cases, `sky.weatherReady` stays `false` and `sky.cloudCover` stays at 0, `sky.sunrise`/`sky.sunset` stay at defaults (6.5 / 19.5). The sky still renders perfectly fine — it just shows a clear sky at fallback times.

**No user-visible error needed.** If the player picked "Local" cloud cover and weather fetch failed, they'll get a clear sky, which is a reasonable default and not worth interrupting the player.

If the player picks "Local" time and the fetch fails, the system clock still drives time-of-day correctly using fallback sunrise/sunset (which look reasonable for mid-latitudes year-round).

## Visual lessons learned (gotchas already solved in sky.js)

If Claude Code wants to modify the cloud rendering, here are the non-obvious things we discovered:

1. **`source-atop` needs transparent destination.** The tint pass on each cloud must happen on a scratch offscreen canvas where everything outside the cloud silhouette IS transparent. Drawing the bitmap onto the main sky canvas first and then trying to tint with `source-atop` makes square clouds — because the sky is opaque, source-atop has no transparent regions to clip to. The current code uses a reusable scratch canvas; don't break this.

2. **Bitmap padding affects positioning.** Each cloud's bitmap is `cloudW + pad*2` wide (pad ~70px) so distortion has room to push pixels. The visible silhouette is centered in the bitmap. When positioning by `y`, subtract `pad` so the silhouette ends up where intended, not 70px lower than expected.

3. **Source gradient should be smooth.** The radial gradient that defines the source blob alpha needs gentle stops (e.g., 0.95 → 0.6 → 0) — anything with a plateau or sharp transition produces visible "ridges" in the displaced output where the alpha bands get distorted but stay sharp.

4. **Final blur pass is essential for soft edges.** A `ctx.filter = 'blur(Npx)'` step after the displacement uniformly softens all edges. Without it, displacement preserves any sharpness in the source.

5. **Sun-occlusion needs to run AFTER cloud drift updates.** The `_drawClouds` method updates each cloud's `x` position. Don't compute occlusion until clouds have been drawn (their positions updated) for the current frame.

6. **The "dimming wash" applies after clouds are drawn.** A full-canvas fillRect with low alpha creates a believable "the sun is getting blocked" effect across the whole scene including terrain. If the dimming feels weak, bump the alpha multiplier (currently `0.55`).

## Performance notes

- **Cloud generation cost**: Each cloud takes ~5–15ms at creation (noise displacement is O(width × height)). With 28 clouds at 100% cover, expect a one-time ~150–400ms hitch when the round starts and clouds are generated. If this is noticeable in actual gameplay, spread `_makeCloud()` calls across several frames using `requestIdleCallback` or a simple "create one cloud per frame until we have enough" loop.

- **Per-frame cost**: Just `drawImage` calls + a tint pass per cloud. Should run at full 60fps on any device that can play the game itself.

- **Memory**: ~15MB total for 28 large cloud bitmaps. Acceptable for desktop, fine for modern mobile.

## Files

- `sky.js` — the module
- `sky-demo.html` — interactive preview page (sliders for time of day and cloud cover, presets, real-weather toggle). Useful for QA after integration to verify nothing broke. Can be deleted from the production build.

## Quick test checklist

After integration:
1. Open game → should see sky render at game-current time with clouds matching local weather (or fallback if offline).
2. Open menu → set Time = Sunset, Cloud Cover = 80% → start round → orange/red sky with heavy clouds.
3. Mid-round, watch a cloud drift across the sun → should darken visibly, sky dims briefly.
4. Try high wind round (e.g., 80 mph) → clouds visibly faster.
5. Try negative wind → clouds drift leftward, wraparound on left edge.
6. Set Time = Random multiple rounds → should get different times.
7. Disconnect internet, restart game → still works fine, defaults to clear sky / fallback sun times.
